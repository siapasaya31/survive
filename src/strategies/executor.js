import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { db, logSpend } from '../lib/budget.js';
import { notify } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';
import { getTokenSymbol, getPoolFee, getEthPrice } from '../lib/prices.js';
import { isInCooldown } from '../lib/cooldown.js';

const CHAIN_DEF = { base, arbitrum, optimism };
const STALE_THRESHOLD_SECONDS = 30;

const LIQUIDATOR_ADDRESS = {
  base:     process.env.LIQUIDATOR_BASE     || '',
  arbitrum: process.env.LIQUIDATOR_ARBITRUM || '',
  optimism: process.env.LIQUIDATOR_OPTIMISM || '',
};

const LIQUIDATOR_ABI = parseAbi([
  'function liquidate(address collateralAsset, address debtAsset, address borrower, uint256 debtAmount, uint24 poolFee, uint256 minProfit) external',
]);

const AAVE_POOL_ABI = parseAbi([
  'function getUserAccountData(address user) external view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getReservesList() external view returns (address[])',
  'function getReserveData(address asset) external view returns (uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, uint128, uint128, uint128)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
]);

const AAVE_V3_POOL = {
  base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

async function getPublicClientFor(chain) {
  const rpcs = [
    process.env[`RPC_${chain.toUpperCase()}`],
    ...Array.from({length: 8}, (_, i) => {
      const k = process.env[`INFURA_KEY_${i+1}`];
      const infuraChain = { base: 'base-mainnet', arbitrum: 'arbitrum-mainnet', optimism: 'optimism-mainnet' }[chain];
      return k ? `https://${infuraChain}.infura.io/v3/${k}` : null;
    }).filter(Boolean),
  ].filter(Boolean);

  for (const rpc of rpcs) {
    try {
      const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(rpc, {timeout: 10000}) });
      await client.getBlockNumber();
      return client;
    } catch {}
  }
  throw new Error(`No working RPC for ${chain}`);
}

async function enrichOpportunity(opp, client, chain) {
  const borrower = opp.raw_data.user;

  const account = await client.readContract({
    address: AAVE_V3_POOL[chain], abi: AAVE_POOL_ABI,
    functionName: 'getUserAccountData', args: [borrower],
  });
  const hf = Number(account[5]) / 1e18;
  if (hf > 1.0) return null;

  const reserves = await client.readContract({
    address: AAVE_V3_POOL[chain], abi: AAVE_POOL_ABI,
    functionName: 'getReservesList',
  });

  let debtAsset = null, collateralAsset = null;
  let maxDebt = 0n, maxCollateral = 0n;

  for (const reserve of reserves) {
    try {
      const rData = await client.readContract({
        address: AAVE_V3_POOL[chain], abi: AAVE_POOL_ABI,
        functionName: 'getReserveData', args: [reserve],
      });
      const aToken = rData[8];
      const stableDebtToken = rData[9];
      const varDebtToken = rData[10];

      const [varDebt, stableDebt, collBal] = await Promise.all([
        client.readContract({ address: varDebtToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [borrower] }),
        client.readContract({ address: stableDebtToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [borrower] }),
        client.readContract({ address: aToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [borrower] }),
      ]);

      const totalDebt = varDebt + stableDebt;
      if (totalDebt > maxDebt) { maxDebt = totalDebt; debtAsset = reserve; }
      if (collBal > maxCollateral) { maxCollateral = collBal; collateralAsset = reserve; }
    } catch {}
  }

  if (!debtAsset || !collateralAsset) return null;

  const collSymbol = getTokenSymbol(chain, collateralAsset) || 'UNKNOWN';
  const debtSymbol = getTokenSymbol(chain, debtAsset) || 'UNKNOWN';
  const poolFee = getPoolFee(collSymbol, debtSymbol);
  const debtToLiquidate = maxDebt / 2n;
  const ethPrice = await getEthPrice(chain);
  const debtDecimals = await client.readContract({ address: debtAsset, abi: ERC20_ABI, functionName: 'decimals' });

  return { borrower, collateralAsset, debtAsset, debtToLiquidate, poolFee, collSymbol, debtSymbol, hf, ethPrice, debtDecimals };
}

async function simulate(client, contractAddr, args, account) {
  try {
    await client.simulateContract({
      address: contractAddr, abi: LIQUIDATOR_ABI, functionName: 'liquidate', args, account,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

export async function executeApproved() {
  const cd = await isInCooldown();
  if (cd.active) {
    logger.warn(`cooldown: ${cd.reverts} reverts, ${cd.remainingMinutes}min remaining`);
    return;
  }

  const r = await db.query(`
    SELECT * FROM opportunities WHERE status = 'approved'
    ORDER BY expected_net_profit_usd DESC LIMIT 5
  `);

  for (const opp of r.rows) {
    const ageSeconds = (Date.now() - new Date(opp.discovered_at).getTime()) / 1000;
    if (ageSeconds > STALE_THRESHOLD_SECONDS) {
      logger.warn(`#${opp.id} stale (${ageSeconds.toFixed(0)}s), skip`);
      await db.query(`UPDATE opportunities SET status='expired', decided_by='stale' WHERE id=$1`, [opp.id]);
      continue;
    }

    const chain = opp.chain;
    const contractAddr = LIQUIDATOR_ADDRESS[chain];
    if (!contractAddr) {
      await db.query(`UPDATE opportunities SET status='rejected', decided_by='no-contract' WHERE id=$1`, [opp.id]);
      continue;
    }

    let client;
    try { client = await getPublicClientFor(chain); }
    catch { continue; }

    const enriched = await enrichOpportunity(opp, client, chain).catch(() => null);
    if (!enriched) {
      await db.query(`UPDATE opportunities SET status='expired', decided_by='hf-recovered' WHERE id=$1`, [opp.id]);
      continue;
    }

    const account = privateKeyToAccount(process.env.ETH_PRIVATE_KEY);
    const minProfitRaw = BigInt(Math.floor(parseFloat(process.env.MIN_NET_PROFIT_USD || '2') * 10**Number(enriched.debtDecimals)));
    const args = [enriched.collateralAsset, enriched.debtAsset, enriched.borrower, enriched.debtToLiquidate, enriched.poolFee, minProfitRaw];

    const sim = await simulate(client, contractAddr, args, account);
    if (!sim.ok) {
      logger.warn(`#${opp.id} sim failed: ${sim.error}`);
      await db.query(`UPDATE opportunities SET status='rejected', decided_by='sim-fail', sim_result=$2 WHERE id=$1`,
        [opp.id, JSON.stringify({ok: false, error: sim.error})]);
      continue;
    }

    logger.info(`#${opp.id} sim passed ✅`);
    const walletClient = createWalletClient({ account, chain: CHAIN_DEF[chain], transport: http(process.env[`RPC_${chain.toUpperCase()}`]) });

    try {
      const gasEstimate = await client.estimateContractGas({
        address: contractAddr, abi: LIQUIDATOR_ABI, functionName: 'liquidate', args, account,
      });
      const gasPrice = await client.getGasPrice();
      const gasCostUsd = Number(gasEstimate * gasPrice) / 1e18 * enriched.ethPrice;

      if (gasCostUsd > parseFloat(process.env.MAX_GAS_PER_TX_USD || '0.50')) {
        await db.query(`UPDATE opportunities SET status='rejected', decided_by='gas-high' WHERE id=$1`, [opp.id]);
        continue;
      }

      logger.info(`executing #${opp.id} on ${chain}, gas=$${gasCostUsd.toFixed(4)}`);
      const hash = await walletClient.writeContract({
        address: contractAddr, abi: LIQUIDATOR_ABI, functionName: 'liquidate', args,
        gas: gasEstimate * 130n / 100n,
      });

      await db.query(`INSERT INTO executions (opportunity_id, chain, tx_hash, tx_status) VALUES ($1,$2,$3,'pending')`, [opp.id, chain, hash]);
      await db.query(`UPDATE opportunities SET status='executed' WHERE id=$1`, [opp.id]);

      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const success = receipt.status === 'success';
      const actualGas = Number(receipt.gasUsed) * Number(gasPrice) / 1e18 * enriched.ethPrice;

      await logSpend({ resource: 'eth_gas', amountUsd: actualGas, chain, txHash: hash, purpose: `liq #${opp.id}` });
      await db.query(`UPDATE executions SET tx_status=$1, gas_used=$2, gas_cost_usd=$3, confirmed_at=NOW() WHERE tx_hash=$4`,
        [success ? 'success' : 'reverted', Number(receipt.gasUsed), actualGas, hash]);

      if (success) {
        const profit = opp.expected_net_profit_usd;
        await db.query(`UPDATE executions SET actual_profit_usd=$1 WHERE tx_hash=$2`, [profit, hash]);
        await notify(`✅ *Liquidation success!*\nChain: \`${chain}\`\n${enriched.collSymbol}→${enriched.debtSymbol}\nTx: \`${hash.slice(0,20)}...\`\nProfit: ~$${profit}\nGas: $${actualGas.toFixed(4)}`);
      } else {
        await notify(`❌ *Reverted* #${opp.id} on ${chain}\nGas: $${actualGas.toFixed(4)}`);
      }
    } catch (e) {
      logger.error(`exec error #${opp.id}: ${e.message}`);
      await db.query(`UPDATE opportunities SET status='failed' WHERE id=$1`, [opp.id]);
    }
  }
}
