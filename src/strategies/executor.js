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

function getRpcPool(chain) {
  const infuraChain = { base: 'base-mainnet', arbitrum: 'arbitrum-mainnet', optimism: 'optimism-mainnet' }[chain];
  const rpcs = [];
  if (process.env['RPC_' + chain.toUpperCase()]) rpcs.push(process.env['RPC_' + chain.toUpperCase()]);
  for (let i = 1; i <= 8; i++) {
    const k = process.env['INFURA_KEY_' + i];
    if (k) rpcs.push('https://' + infuraChain + '.infura.io/v3/' + k);
  }
  return rpcs;
}

async function getWorkingClient(chain) {
  for (const rpc of getRpcPool(chain)) {
    try {
      const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(rpc, {timeout: 10000}) });
      await client.getBlockNumber();
      return { client, rpc };
    } catch {}
  }
  throw new Error('No RPC for ' + chain);
}

async function enrichOpportunity(opp, client, chain) {
  const borrower = opp.raw_data.user;
  const account = await client.readContract({ address: AAVE_V3_POOL[chain], abi: AAVE_POOL_ABI, functionName: 'getUserAccountData', args: [borrower] });
  const hf = Number(account[5]) / 1e18;
  if (hf > 1.0) return null;
  const reserves = await client.readContract({ address: AAVE_V3_POOL[chain], abi: AAVE_POOL_ABI, functionName: 'getReservesList' });
  let debtAsset = null, collateralAsset = null, maxDebt = 0n, maxCollateral = 0n;
  for (const reserve of reserves) {
    try {
      const rData = await client.readContract({ address: AAVE_V3_POOL[chain], abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [reserve] });
      const [aToken, stableDebtToken, varDebtToken] = [rData[8], rData[9], rData[10]];
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
    await client.simulateContract({ address: contractAddr, abi: LIQUIDATOR_ABI, functionName: 'liquidate', args, account });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

export async function autoLiquidate(opp) {
  const chain = opp.chain;
  const cd = await isInCooldown();
  if (cd.active) return { skipped: true, reason: 'cooldown ' + cd.remainingMinutes + 'min' };

  const contractAddr = LIQUIDATOR_ADDRESS[chain];
  if (!contractAddr) {
    await db.query('UPDATE opportunities SET status=$1, decided_by=$2 WHERE id=$3', ['rejected', 'no-contract', opp.id]);
    return { skipped: true, reason: 'no contract' };
  }

  let clientData;
  try { clientData = await getWorkingClient(chain); } catch { return { skipped: true, reason: 'no RPC' }; }
  const { client, rpc } = clientData;

  const enriched = await enrichOpportunity(opp, client, chain).catch(() => null);
  if (!enriched) {
    await db.query('UPDATE opportunities SET status=$1, decided_by=$2 WHERE id=$3', ['expired', 'hf-recovered', opp.id]);
    return { skipped: true, reason: 'HF recovered' };
  }

  const account = privateKeyToAccount(process.env.ETH_PRIVATE_KEY);
  const minProfitRaw = BigInt(Math.floor(parseFloat(process.env.MIN_NET_PROFIT_USD || '2') * 10**Number(enriched.debtDecimals)));
  const args = [enriched.collateralAsset, enriched.debtAsset, enriched.borrower, enriched.debtToLiquidate, enriched.poolFee, minProfitRaw];

  const sim = await simulate(client, contractAddr, args, account);
  if (!sim.ok) {
    await db.query('UPDATE opportunities SET status=$1, decided_by=$2, sim_result=$3 WHERE id=$4',
      ['rejected', 'sim-fail', JSON.stringify({ ok: false, error: sim.error }), opp.id]);
    return { skipped: true, reason: 'sim-fail: ' + sim.error };
  }

  let gasEstimate, gasPrice, gasCostUsd;
  try {
    gasEstimate = await client.estimateContractGas({ address: contractAddr, abi: LIQUIDATOR_ABI, functionName: 'liquidate', args, account });
    gasPrice = await client.getGasPrice();
    gasCostUsd = Number(gasEstimate * gasPrice) / 1e18 * enriched.ethPrice;
  } catch (e) { return { skipped: true, reason: 'gas estimate: ' + e.message }; }

  if (gasCostUsd > parseFloat(process.env.MAX_GAS_PER_TX_USD || '0.50')) {
    await db.query('UPDATE opportunities SET status=$1, decided_by=$2 WHERE id=$3', ['rejected', 'gas-high', opp.id]);
    return { skipped: true, reason: 'gas $' + gasCostUsd.toFixed(4) + ' too high' };
  }

  logger.info('liquidating #' + opp.id + ' on ' + chain + ' gas=$' + gasCostUsd.toFixed(4));
  const walletClient = createWalletClient({ account, chain: CHAIN_DEF[chain], transport: http(rpc) });

  try {
    const hash = await walletClient.writeContract({ address: contractAddr, abi: LIQUIDATOR_ABI, functionName: 'liquidate', args, gas: gasEstimate * 130n / 100n });
    await db.query('INSERT INTO executions (opportunity_id, chain, tx_hash, tx_status) VALUES ($1,$2,$3,$4)', [opp.id, chain, hash, 'pending']);
    await db.query('UPDATE opportunities SET status=$1 WHERE id=$2', ['executed', opp.id]);

    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60000 });
    const success = receipt.status === 'success';
    const actualGas = Number(receipt.gasUsed) * Number(gasPrice) / 1e18 * enriched.ethPrice;

    await logSpend({ resource: 'eth_gas', amountUsd: actualGas, chain, txHash: hash, purpose: 'liq #' + opp.id });
    await db.query('UPDATE executions SET tx_status=$1, gas_used=$2, gas_cost_usd=$3, confirmed_at=NOW() WHERE tx_hash=$4',
      [success ? 'success' : 'reverted', Number(receipt.gasUsed), actualGas, hash]);

    if (success) {
      await db.query('UPDATE executions SET actual_profit_usd=$1 WHERE tx_hash=$2', [opp.expected_net_profit_usd, hash]);
    } else {
      await notify('❌ *Reverted* #' + opp.id + ' on ' + chain + '\nGas: $' + actualGas.toFixed(4));
    }
    return { success, hash, gasCost: actualGas, skipped: false };
  } catch (e) {
    logger.error('exec error #' + opp.id + ': ' + e.message);
    await db.query('UPDATE opportunities SET status=$1 WHERE id=$2', ['failed', opp.id]);
    return { success: false, skipped: false, reason: e.message };
  }
}

export async function executeApproved() {
  const r = await db.query('SELECT * FROM opportunities WHERE status = $1 ORDER BY expected_net_profit_usd DESC LIMIT 5', ['approved']);
  for (const opp of r.rows) await autoLiquidate(opp);
}
