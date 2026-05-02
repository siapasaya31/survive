import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createWalletClient, createPublicClient, http, parseAbi, encodeAbiParameters, parseAbiParameters } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { db, logSpend } from '../lib/budget.js';
import { notify } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';
import { getEthPrice, getPoolFee, getTokenSymbol } from '../lib/prices.js';
import { isInCooldown } from '../lib/cooldown.js';

const CHAIN_DEF = { base, arbitrum, optimism };

const MULTI_LIQ = {
  base:     process.env.MULTI_LIQUIDATOR_BASE     || '',
  arbitrum: process.env.MULTI_LIQUIDATOR_ARBITRUM || '',
  optimism: process.env.MULTI_LIQUIDATOR_OPTIMISM || '',
};

const SWAP_ROUTER = {
  base:     '0x2626664c2603336E57B271c5C0b26F421741e481',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  optimism: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
};

const PROTOCOL_ENUM = { aave: 0, aave_v3: 0, compound: 1, compound_v3: 1, morpho: 2, morpho_blue: 2 };

const MULTI_LIQ_ABI = parseAbi([
  'struct LiqParams { uint8 protocol; address pool; address collateralAsset; address debtAsset; address borrower; uint256 debtAmount; address swapRouter; uint24 poolFee; uint256 minProfit; bytes extra; }',
  'function liquidate((uint8,address,address,address,address,uint256,address,uint24,uint256,bytes) p) external',
]);

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

function makeClients(chain) {
  const account = privateKeyToAccount(process.env.ETH_PRIVATE_KEY);
  const transport = http(getRpc(chain), { timeout: 12000, retryCount: 1 });
  return {
    public: createPublicClient({ chain: CHAIN_DEF[chain], transport }),
    wallet: createWalletClient({ account, chain: CHAIN_DEF[chain], transport }),
    account,
  };
}

export async function executeMultiProtocol(opp) {
  const cd = await isInCooldown();
  if (cd.active) return { skipped: true, reason: 'cooldown ' + cd.remainingMinutes + 'min' };

  const chain = opp.chain;
  const multi = MULTI_LIQ[chain];
  if (!multi) {
    await db.query('UPDATE opportunities SET status=$1, decided_by=$2 WHERE id=$3', ['rejected', 'no-multi-contract', opp.id]);
    return { skipped: true, reason: 'no multi-liquidator' };
  }

  const protocol = opp.strategy?.replace('_liq', '') || 'aave';
  const protoEnum = PROTOCOL_ENUM[protocol];
  if (protoEnum === undefined) {
    return { skipped: true, reason: 'unknown protocol ' + protocol };
  }

  const raw = opp.raw_data;
  const { public: client, wallet, account } = makeClients(chain);

  // Pool address per protocol
  const POOL_ADDR = {
    aave_v3: { base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
    compound_v3: { base: '0xb125E6687d4313864e53df431d5425969c15Eb2F', arbitrum: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf' },
    morpho_blue: { base: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' },
  };

  const poolKey = protocol === 'aave' ? 'aave_v3' : (protocol === 'compound' ? 'compound_v3' : (protocol === 'morpho' ? 'morpho_blue' : protocol));
  const pool = POOL_ADDR[poolKey]?.[chain];
  if (!pool) return { skipped: true, reason: 'no pool address for ' + poolKey + ' on ' + chain };

  // Build params per protocol
  let collateralAsset, debtAsset, debtAmount, extra = '0x';

  if (protocol === 'aave' || protocol === 'aave_v3') {
    collateralAsset = raw.collateralAsset || raw.collateral_asset;
    debtAsset       = raw.debtAsset || raw.debt_asset;
    debtAmount      = raw.debtToLiquidate || raw.debtAmount || BigInt(Math.floor((raw.debtUsd || 0) * 1e6));
    if (typeof debtAmount === 'string') debtAmount = BigInt(debtAmount);
  } else if (protocol === 'compound' || protocol === 'compound_v3') {
    collateralAsset = raw.collateralAsset;
    debtAsset       = raw.debtAsset;
    debtAmount      = raw.debtAmount || raw.debt_amount;
    if (!debtAmount) return { skipped: true, reason: 'no debt amount' };
    if (typeof debtAmount === 'string') debtAmount = BigInt(debtAmount);
  } else if (protocol === 'morpho' || protocol === 'morpho_blue') {
    collateralAsset = raw.collateralAsset;
    debtAsset       = raw.debtAsset;
    debtAmount      = raw.borrowShares ? BigInt(raw.borrowShares) / 2n : 0n;
    // Encode MarketParams + seizedAssets for morpho
    const mp = raw.marketParams || {};
    const seized = BigInt(raw.collateralAmount || 0) / 2n;
    extra = encodeAbiParameters(
      parseAbiParameters('(address,address,address,address,uint256), uint256'),
      [[mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, BigInt(mp.lltv || 0)], seized]
    );
  }

  if (!collateralAsset || !debtAsset || !debtAmount) {
    return { skipped: true, reason: 'missing assets' };
  }

  const collSymbol = getTokenSymbol(chain, collateralAsset) || 'UNK';
  const debtSymbol = getTokenSymbol(chain, debtAsset) || 'UNK';
  const poolFee = getPoolFee(collSymbol, debtSymbol);
  const ethPrice = await getEthPrice(chain);

  // Get debt decimals
  const ERC20 = parseAbi(['function decimals() external view returns (uint8)']);
  let debtDecimals = 6;
  try {
    debtDecimals = Number(await client.readContract({ address: debtAsset, abi: ERC20, functionName: 'decimals' }));
  } catch {}

  const minProfit = BigInt(Math.floor(parseFloat(process.env.MIN_NET_PROFIT_USD || '0.50') * 10**debtDecimals));

  const params = [protoEnum, pool, collateralAsset, debtAsset, raw.borrower || raw.user, debtAmount, SWAP_ROUTER[chain], poolFee, minProfit, extra];

  // Pre-execute simulation
  try {
    await client.simulateContract({
      address: multi, abi: MULTI_LIQ_ABI, functionName: 'liquidate', args: [params], account,
    });
  } catch (e) {
    await db.query('UPDATE opportunities SET status=$1, decided_by=$2, sim_result=$3 WHERE id=$4',
      ['rejected', 'sim-fail', JSON.stringify({ ok: false, error: e.message.slice(0, 150) }), opp.id]);
    return { skipped: true, reason: 'sim-fail' };
  }

  // Gas check
  let gasEstimate, gasPrice, gasCostUsd;
  try {
    gasEstimate = await client.estimateContractGas({ address: multi, abi: MULTI_LIQ_ABI, functionName: 'liquidate', args: [params], account });
    gasPrice = await client.getGasPrice();
    gasCostUsd = Number(gasEstimate * gasPrice) / 1e18 * ethPrice;
  } catch (e) { return { skipped: true, reason: 'gas-fail' }; }

  if (gasCostUsd > parseFloat(process.env.MAX_GAS_PER_TX_USD || '0.30')) {
    await db.query('UPDATE opportunities SET status=$1, decided_by=$2 WHERE id=$3', ['rejected', 'gas-high', opp.id]);
    return { skipped: true, reason: 'gas $' + gasCostUsd.toFixed(4) + ' too high' };
  }

  logger.info('multi-liq #' + opp.id + ' ' + protocol + ' on ' + chain + ' gas=$' + gasCostUsd.toFixed(4));

  try {
    const hash = await wallet.writeContract({
      address: multi, abi: MULTI_LIQ_ABI, functionName: 'liquidate', args: [params],
      gas: gasEstimate * 130n / 100n,
    });

    await db.query('INSERT INTO executions (opportunity_id, chain, tx_hash, tx_status) VALUES ($1,$2,$3,$4)', [opp.id, chain, hash, 'pending']);
    await db.query('UPDATE opportunities SET status=$1 WHERE id=$2', ['executed', opp.id]);

    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60000 });
    const success = receipt.status === 'success';
    const actualGas = Number(receipt.gasUsed) * Number(gasPrice) / 1e18 * ethPrice;

    await logSpend({ resource: 'eth_gas', amountUsd: actualGas, chain, txHash: hash, purpose: 'multi-liq #' + opp.id });
    await db.query('UPDATE executions SET tx_status=$1, gas_used=$2, gas_cost_usd=$3, confirmed_at=NOW() WHERE tx_hash=$4',
      [success ? 'success' : 'reverted', Number(receipt.gasUsed), actualGas, hash]);

    if (success) {
      const profit = opp.expected_net_profit_usd;
      await db.query('UPDATE executions SET actual_profit_usd=$1 WHERE tx_hash=$2', [profit, hash]);
      await notify('✅ *Multi-protocol liquidation*\n' + protocol + ' on ' + chain + '\nTx: `' + hash.slice(0,20) + '...`\nProfit ~$' + profit + '\nGas $' + actualGas.toFixed(4));
    } else {
      await notify('❌ Reverted multi-liq #' + opp.id + ' (' + protocol + '/' + chain + ') gas $' + actualGas.toFixed(4));
    }

    return { success, hash, gasCost: actualGas, skipped: false };
  } catch (e) {
    logger.error('multi exec #' + opp.id + ': ' + e.message);
    await db.query('UPDATE opportunities SET status=$1 WHERE id=$2', ['failed', opp.id]);
    return { success: false, skipped: false, reason: e.message };
  }
}
