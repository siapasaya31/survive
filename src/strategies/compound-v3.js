import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { db } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

// Compound V3 Comet contracts (USDC markets)
export const COMET_USDC = {
  base:     '0xb125E6687d4313864e53df431d5425969c15Eb2F',
  arbitrum: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
  // Optimism doesn't have Compound V3 USDC market yet
};

export const COMET_USDbC = {
  base: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', // USDbC market on Base
};

const COMET_ABI = parseAbi([
  'function isLiquidatable(address account) external view returns (bool)',
  'function getCollateralReserves(address asset) external view returns (uint256)',
  'function userCollateral(address account, address asset) external view returns (uint128 balance, uint128)',
  'function userBasic(address account) external view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn, uint8 _reserved)',
  'function getAssetInfo(uint8 i) external view returns (uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap)',
  'function numAssets() external view returns (uint8)',
  'function baseToken() external view returns (address)',
  'function quoteCollateral(address asset, uint256 baseAmount) external view returns (uint256)',
]);

const WITHDRAW_EVENT_ABI = [{
  type: 'event', name: 'Withdraw',
  inputs: [
    { type: 'address', indexed: true,  name: 'src' },
    { type: 'address', indexed: true,  name: 'to' },
    { type: 'uint256', indexed: false, name: 'amount' },
  ],
}];

const SUPPLY_EVENT_ABI = [{
  type: 'event', name: 'Supply',
  inputs: [
    { type: 'address', indexed: true,  name: 'from' },
    { type: 'address', indexed: true,  name: 'dst' },
    { type: 'uint256', indexed: false, name: 'amount' },
  ],
}];

function getRpc(chain) {
  return process.env[`RPC_${chain.toUpperCase()}`];
}

async function getCometAssets(chain, cometAddr) {
  const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
  const numAssets = await client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: 'numAssets' });
  const assets = [];
  for (let i = 0; i < Number(numAssets); i++) {
    try {
      const info = await client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: 'getAssetInfo', args: [i] });
      assets.push({ asset: info[1], priceFeed: info[2], liquidateCollateralFactor: Number(info[5]) });
    } catch {}
  }
  return assets;
}

export async function checkCompoundLiquidatable(chain, cometAddr, account) {
  const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
  try {
    const isLiq = await client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: 'isLiquidatable', args: [account] });
    if (!isLiq) return null;

    // Get user collateral across all supported assets
    const assets = await getCometAssets(chain, cometAddr);
    let largestColl = { asset: null, balance: 0n };

    for (const a of assets) {
      try {
        const bal = await client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: 'userCollateral', args: [account, a.asset] });
        if (bal[0] > largestColl.balance) {
          largestColl = { asset: a.asset, balance: bal[0] };
        }
      } catch {}
    }

    if (!largestColl.asset) return null;

    const baseToken = await client.readContract({ address: cometAddr, abi: COMET_ABI, functionName: 'baseToken' });

    return {
      isLiquidatable: true,
      borrower: account,
      collateralAsset: largestColl.asset,
      collateralBalance: largestColl.balance,
      debtAsset: baseToken,
      cometAddr,
    };
  } catch (e) {
    logger.warn(`compound check failed: ${e.message}`);
    return null;
  }
}

// Subscribe to Withdraw events on Comet — these often precede liquidation conditions
export function subscribeCompoundEvents(chain, wsClient, onLiquidatable) {
  const cometAddr = COMET_USDC[chain];
  if (!cometAddr) return;

  wsClient.watchContractEvent({
    address: cometAddr,
    abi: WITHDRAW_EVENT_ABI,
    eventName: 'Withdraw',
    onLogs: async (logs) => {
      for (const log of logs) {
        const account = log.args.src;
        if (!account) continue;
        const result = await checkCompoundLiquidatable(chain, cometAddr, account);
        if (result) {
          logger.info(`Compound V3 liquidatable: ${chain} ${account.slice(0,10)}`);
          onLiquidatable(chain, result);
        }
      }
    },
    onError: (e) => logger.warn(`Compound withdraw watch ${chain}: ${e.message}`),
  });
}

export async function scanAllCompoundUsers(chain) {
  const cometAddr = COMET_USDC[chain];
  if (!cometAddr) return [];

  const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });

  // Get recent Withdraw events to find active borrowers
  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest - 5000n; // last ~3 hours
    const logs = await client.getLogs({
      address: cometAddr,
      event: WITHDRAW_EVENT_ABI[0],
      fromBlock, toBlock: latest,
    });

    const accounts = [...new Set(logs.map(l => l.args.src).filter(Boolean))];
    const liquidatable = [];

    for (const acc of accounts.slice(0, 50)) {
      const result = await checkCompoundLiquidatable(chain, cometAddr, acc);
      if (result) liquidatable.push(result);
    }
    return liquidatable;
  } catch (e) {
    logger.warn(`scanAllCompoundUsers ${chain}: ${e.message}`);
    return [];
  }
}
