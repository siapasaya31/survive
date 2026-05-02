import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { db, logSpend } from '../lib/budget.js';
import { notify } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';
import { getEthPrice } from '../lib/prices.js';
import { isInCooldown } from '../lib/cooldown.js';

const CHAIN_DEF = { base, arbitrum, optimism };

const BACKRUN_CONTRACT = {
  base:     process.env.BACKRUN_BASE     || '',
  arbitrum: process.env.BACKRUN_ARBITRUM || '',
  optimism: process.env.BACKRUN_OPTIMISM || '',
};

const BACKRUN_ABI = parseAbi([
  'struct ArbParams { address tokenA; address tokenB; uint256 borrowAmount; address routerForward; uint24 feeForward; address routerReverse; uint24 feeReverse; uint256 minProfit; }',
  'function arb((address,address,uint256,address,uint24,address,uint24,uint256) p) external',
]);

// Counterpart pool addresses for backrun (need 2nd pool of same pair on different DEX/fee tier)
// Format: { triggeredPoolAddress: { tokenA, tokenB, counterpartRouter, counterpartFee } }
const BACKRUN_PAIRS = {
  base: {
    // WETH/USDC 0.05% Uniswap V3 → counterpart: WETH/USDC Aerodrome stable
    '0xd0b53D9277642d899DF5C87A3966A349A798F224': {
      tokenA: '0x4200000000000000000000000000000000000006', // WETH
      tokenB: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      counterpartRouter: '0x2626664c2603336E57B271c5C0b26F421741e481', // Uniswap V3 router
      counterpartFee: 3000, // try 0.3% pool as counterpart
    },
  },
  arbitrum: {
    '0xC6962004f452bE9203591991D15f6b388e09E8D0': {
      tokenA: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
      tokenB: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC
      counterpartRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      counterpartFee: 3000,
    },
  },
  optimism: {
    '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b': {
      tokenA: '0x4200000000000000000000000000000000000006',
      tokenB: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      counterpartRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      counterpartFee: 3000,
    },
  },
};

const ROUTER_PRIMARY = {
  base:     '0x2626664c2603336E57B271c5C0b26F421741e481',
  arbitrum: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  optimism: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
};

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

export async function tryBackrun(chain, swapData) {
  const cd = await isInCooldown();
  if (cd.active) return { skipped: true, reason: 'cooldown' };

  const contract = BACKRUN_CONTRACT[chain];
  if (!contract) return { skipped: true, reason: 'no backrun contract' };

  const pairConfig = BACKRUN_PAIRS[chain]?.[swapData.poolAddress?.toLowerCase()] ||
                     BACKRUN_PAIRS[chain]?.[swapData.poolAddress];
  if (!pairConfig) return { skipped: true, reason: 'no pair config' };

  // Calculate borrow amount: 10% of large swap size, max $50 (modal kecil)
  const swapAmount = BigInt(swapData.amount1 || 0);
  const absSwap = swapAmount < 0n ? -swapAmount : swapAmount;
  const borrowAmount = absSwap / 20n; // 5% of triggered swap
  if (borrowAmount === 0n) return { skipped: true, reason: 'zero borrow' };

  const ethPrice = await getEthPrice(chain);
  const account = privateKeyToAccount(process.env.ETH_PRIVATE_KEY);
  const transport = http(getRpc(chain), { timeout: 8000, retryCount: 1 });
  const client = createPublicClient({ chain: CHAIN_DEF[chain], transport });
  const wallet = createWalletClient({ account, chain: CHAIN_DEF[chain], transport });

  const minProfit = 1n * 10n ** 15n; // 0.001 ETH minimum

  const args = [
    pairConfig.tokenA,
    pairConfig.tokenB,
    borrowAmount,
    ROUTER_PRIMARY[chain],
    500, // 0.05% fee
    pairConfig.counterpartRouter,
    pairConfig.counterpartFee,
    minProfit,
  ];

  // Simulate first
  try {
    await client.simulateContract({
      address: contract, abi: BACKRUN_ABI, functionName: 'arb',
      args: [args], account,
    });
  } catch (e) {
    return { skipped: true, reason: 'sim-fail: ' + e.message.slice(0, 80) };
  }

  // Gas check
  let gasEstimate, gasPrice, gasCostUsd;
  try {
    gasEstimate = await client.estimateContractGas({
      address: contract, abi: BACKRUN_ABI, functionName: 'arb', args: [args], account,
    });
    gasPrice = await client.getGasPrice();
    gasCostUsd = Number(gasEstimate * gasPrice) / 1e18 * ethPrice;
  } catch { return { skipped: true, reason: 'gas-fail' }; }

  if (gasCostUsd > parseFloat(process.env.MAX_GAS_PER_TX_USD || '0.30')) {
    return { skipped: true, reason: 'gas too high' };
  }

  logger.info('🎯 backrun ' + chain + ' borrow=' + borrowAmount.toString() + ' gas=$' + gasCostUsd.toFixed(4));

  // Insert as opportunity
  const fp = 'backrun:' + chain + ':' + swapData.poolAddress + ':' + swapData.txHash;
  const oppRow = await db.query(
    'INSERT INTO opportunities (strategy, chain, fingerprint, raw_data, triage_score, expected_gross_profit_usd, expected_gas_cost_usd, expected_net_profit_usd, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (fingerprint) DO NOTHING RETURNING id',
    ['backrun', chain, fp, JSON.stringify({ ...swapData, borrowAmount: borrowAmount.toString() }), 80, 0.5, gasCostUsd, 0.5 - gasCostUsd, 'executed']
  );
  const oppId = oppRow.rows[0]?.id;
  if (!oppId) return { skipped: true, reason: 'duplicate' };

  try {
    const hash = await wallet.writeContract({
      address: contract, abi: BACKRUN_ABI, functionName: 'arb',
      args: [args], gas: gasEstimate * 130n / 100n,
    });

    await db.query('INSERT INTO executions (opportunity_id, chain, tx_hash, tx_status) VALUES ($1,$2,$3,$4)', [oppId, chain, hash, 'pending']);

    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30000 });
    const success = receipt.status === 'success';
    const actualGas = Number(receipt.gasUsed) * Number(gasPrice) / 1e18 * ethPrice;

    await logSpend({ resource: 'eth_gas', amountUsd: actualGas, chain, txHash: hash, purpose: 'backrun' });
    await db.query('UPDATE executions SET tx_status=$1, gas_used=$2, gas_cost_usd=$3, confirmed_at=NOW() WHERE tx_hash=$4',
      [success ? 'success' : 'reverted', Number(receipt.gasUsed), actualGas, hash]);

    if (success) {
      await notify('✅ *Backrun success!*\n' + chain + ' tx `' + hash.slice(0,20) + '...`\nGas $' + actualGas.toFixed(4));
    } else {
      logger.warn('backrun reverted: ' + hash);
    }
    return { success, hash };
  } catch (e) {
    logger.error('backrun exec: ' + e.message);
    return { success: false, reason: e.message };
  }
}
