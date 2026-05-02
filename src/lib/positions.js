import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { db } from './budget.js';
import { logger } from './logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

const AAVE_V3_POOL = {
  base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

const POOL_ABI = parseAbi([
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);

const BORROW_EVENT_ABI = [{
  type: 'event', name: 'Borrow',
  inputs: [
    { type: 'address', indexed: true,  name: 'reserve' },
    { type: 'address', indexed: false, name: 'user' },
    { type: 'address', indexed: true,  name: 'onBehalfOf' },
    { type: 'uint256', indexed: false, name: 'amount' },
    { type: 'uint8',   indexed: false, name: 'interestRateMode' },
    { type: 'uint256', indexed: false, name: 'borrowRate' },
    { type: 'uint16',  indexed: true,  name: 'referralCode' },
  ],
}];

const REPAY_EVENT_ABI = [{
  type: 'event', name: 'Repay',
  inputs: [
    { type: 'address', indexed: true,  name: 'reserve' },
    { type: 'address', indexed: true,  name: 'user' },
    { type: 'address', indexed: true,  name: 'repayer' },
    { type: 'uint256', indexed: false, name: 'amount' },
    { type: 'bool',    indexed: false, name: 'useATokens' },
  ],
}];

const LIQUIDATION_EVENT_ABI = [{
  type: 'event', name: 'LiquidationCall',
  inputs: [
    { type: 'address', indexed: true,  name: 'collateralAsset' },
    { type: 'address', indexed: true,  name: 'debtAsset' },
    { type: 'address', indexed: true,  name: 'user' },
    { type: 'uint256', indexed: false, name: 'debtToCover' },
    { type: 'uint256', indexed: false, name: 'liquidatedCollateralAmount' },
    { type: 'address', indexed: false, name: 'liquidator' },
    { type: 'bool',    indexed: false, name: 'receiveAToken' },
  ],
}];

function getRpcPool(chain) {
  const infuraChain = { base: 'base-mainnet', arbitrum: 'arbitrum-mainnet', optimism: 'optimism-mainnet' }[chain];
  const rpcs = [];
  if (process.env[`RPC_${chain.toUpperCase()}`]) rpcs.push(process.env[`RPC_${chain.toUpperCase()}`]);
  for (let i = 1; i <= 8; i++) {
    const k = process.env[`INFURA_KEY_${i}`];
    if (k) rpcs.push(`https://${infuraChain}.infura.io/v3/${k}`);
  }
  return rpcs;
}

function makeClient(chain, rpc) {
  return createPublicClient({ chain: CHAIN_DEF[chain], transport: http(rpc, {timeout: 12000, retryCount: 1}) });
}

async function getWorkingClient(chain) {
  for (const rpc of getRpcPool(chain)) {
    try {
      const client = makeClient(chain, rpc);
      await client.getBlockNumber();
      return client;
    } catch {}
  }
  throw new Error(`No RPC for ${chain}`);
}

export async function upsertPosition(chain, borrower, data) {
  await db.query(`
    INSERT INTO active_positions (chain, borrower, collateral_usd, debt_usd, health_factor, last_checked_at, is_liquidatable)
    VALUES ($1,$2,$3,$4,$5,NOW(),$6)
    ON CONFLICT (chain, borrower) DO UPDATE SET
      collateral_usd=EXCLUDED.collateral_usd,
      debt_usd=EXCLUDED.debt_usd,
      health_factor=EXCLUDED.health_factor,
      last_checked_at=NOW(),
      is_liquidatable=EXCLUDED.is_liquidatable
  `, [chain, borrower, data.collateralUsd, data.debtUsd, data.hf, data.hf < 1.0]);
}

export async function removePosition(chain, borrower) {
  await db.query(`DELETE FROM active_positions WHERE chain=$1 AND borrower=$2`, [chain, borrower]);
}

export async function refreshPosition(chain, borrower, client) {
  try {
    const data = await client.readContract({
      address: AAVE_V3_POOL[chain], abi: POOL_ABI,
      functionName: 'getUserAccountData', args: [borrower],
    });
    const collateralUsd = Number(data[0]) / 1e8;
    const debtUsd       = Number(data[1]) / 1e8;
    const hf            = Number(data[5]) / 1e18;

    if (debtUsd < 1) {
      await removePosition(chain, borrower);
      return null;
    }
    await upsertPosition(chain, borrower, { collateralUsd, debtUsd, hf });
    return { collateralUsd, debtUsd, hf };
  } catch (e) {
    logger.warn(`refreshPosition ${chain}:${borrower.slice(0,10)} failed: ${e.message}`);
    return null;
  }
}

// Scan all stored positions for a chain and update health factors
export async function scanStoredPositions(chain) {
  const r = await db.query(
    `SELECT borrower FROM active_positions WHERE chain=$1 ORDER BY last_checked_at ASC LIMIT 100`,
    [chain]
  );
  if (r.rows.length === 0) return 0;

  const client = await getWorkingClient(chain);
  let liquidatable = 0;

  for (const row of r.rows) {
    const pos = await refreshPosition(chain, row.borrower, client);
    if (pos && pos.hf < 1.0 && pos.collateralUsd > 50) liquidatable++;
  }
  logger.info(`scanStoredPositions ${chain}: ${r.rows.length} checked, ${liquidatable} liquidatable`);
  return liquidatable;
}

// Get all liquidatable positions from DB
export async function getLiquidatablePositions(chain) {
  const r = await db.query(`
    SELECT * FROM active_positions
    WHERE chain=$1 AND is_liquidatable=true AND collateral_usd > 50 AND collateral_usd < 800
    ORDER BY health_factor ASC
  `, [chain]);
  return r.rows;
}

// Subscribe to borrow/repay/liquidation events to keep DB current
export function subscribePositionEvents(chain, wsClient, onLiquidatable) {
  // New borrower → add to tracking
  wsClient.watchContractEvent({
    address: AAVE_V3_POOL[chain],
    abi: BORROW_EVENT_ABI,
    eventName: 'Borrow',
    onLogs: async (logs) => {
      for (const log of logs) {
        const borrower = log.args.onBehalfOf;
        if (!borrower) continue;
        try {
          const client = await getWorkingClient(chain);
          const pos = await refreshPosition(chain, borrower, client);
          if (pos && pos.hf < 1.0 && pos.collateralUsd > 50) {
            logger.info(`new liquidatable from Borrow: ${chain} ${borrower.slice(0,10)} hf=${pos.hf.toFixed(4)}`);
            onLiquidatable(chain, borrower, pos);
          }
        } catch {}
      }
    },
    onError: (e) => logger.warn(`Borrow watch ${chain}: ${e.message}`),
  });

  // Repay → update
  wsClient.watchContractEvent({
    address: AAVE_V3_POOL[chain],
    abi: REPAY_EVENT_ABI,
    eventName: 'Repay',
    onLogs: async (logs) => {
      for (const log of logs) {
        const borrower = log.args.user;
        if (!borrower) continue;
        try {
          const client = await getWorkingClient(chain);
          await refreshPosition(chain, borrower, client);
        } catch {}
      }
    },
    onError: (e) => logger.warn(`Repay watch ${chain}: ${e.message}`),
  });

  // Liquidation → remove (already liquidated)
  wsClient.watchContractEvent({
    address: AAVE_V3_POOL[chain],
    abi: LIQUIDATION_EVENT_ABI,
    eventName: 'LiquidationCall',
    onLogs: async (logs) => {
      for (const log of logs) {
        const borrower = log.args.user;
        if (!borrower) continue;
        logger.info(`LiquidationCall detected: ${chain} ${borrower.slice(0,10)} — removing from DB`);
        await removePosition(chain, borrower).catch(() => {});
      }
    },
    onError: (e) => logger.warn(`LiquidationCall watch ${chain}: ${e.message}`),
  });
}
