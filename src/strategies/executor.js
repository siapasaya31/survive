import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { db } from '../lib/budget.js';
import { logSpend } from '../lib/budget.js';
import { notify } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

// Fill this after deploy
const LIQUIDATOR_ADDRESS = {
  base:     process.env.LIQUIDATOR_BASE     || '',
  arbitrum: process.env.LIQUIDATOR_ARBITRUM || '',
  optimism: process.env.LIQUIDATOR_OPTIMISM || '',
};

const LIQUIDATOR_ABI = parseAbi([
  'function liquidate(address collateralAsset, address debtAsset, address borrower, uint256 debtAmount, uint24 poolFee, uint256 minProfit) external',
]);

// Pool fees for Uniswap V3
const POOL_FEE = {
  stable: 500,   // 0.05% for stablecoin pairs
  normal: 3000,  // 0.3% default
  exotic: 10000, // 1% for exotic pairs
};

// Common token addresses per chain
const TOKENS = {
  base: {
    USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    WETH:  '0x4200000000000000000000000000000000000006',
    cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  },
  arbitrum: {
    USDC:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    WETH:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDT:  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  },
  optimism: {
    USDC:  '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    WETH:  '0x4200000000000000000000000000000000000006',
    USDT:  '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  },
};

function guessPoolFee(collateralSymbol, debtSymbol) {
  const stables = ['USDC', 'USDT', 'DAI', 'USDbC'];
  if (stables.includes(collateralSymbol) && stables.includes(debtSymbol)) return POOL_FEE.stable;
  return POOL_FEE.normal;
}

export async function executeApproved() {
  const r = await db.query(`
    SELECT * FROM opportunities
    WHERE status = 'approved'
    ORDER BY expected_net_profit_usd DESC
    LIMIT 3
  `);

  for (const opp of r.rows) {
    const chain = opp.chain;
    const contractAddr = LIQUIDATOR_ADDRESS[chain];

    if (!contractAddr) {
      logger.warn(`No liquidator deployed on ${chain} — skip opp #${opp.id}`);
      await db.query(`UPDATE opportunities SET status='rejected', decided_by='no-contract' WHERE id=$1`, [opp.id]);
      continue;
    }

    const raw = opp.raw_data;
    const borrower = raw.user;
    const collateralAsset = raw.collateralAsset || TOKENS[chain]?.WETH;
    const debtAsset = raw.debtAsset || TOKENS[chain]?.USDC;
    const debtAmount = BigInt(Math.floor(raw.debtUsd * 1e6)); // USDC 6 decimals
    const minProfitUsd = parseFloat(process.env.MIN_NET_PROFIT_USD || '2');
    const minProfit = BigInt(Math.floor(minProfitUsd * 1e6));
    const poolFee = guessPoolFee('WETH', 'USDC');

    const account = privateKeyToAccount(process.env.ETH_PRIVATE_KEY);
    const walletClient = createWalletClient({
      account,
      chain: CHAIN_DEF[chain],
      transport: http(),
    });
    const publicClient = createPublicClient({
      chain: CHAIN_DEF[chain],
      transport: http(),
    });

    try {
      logger.info(`executing liquidation #${opp.id} on ${chain}`);

      // Estimate gas first
      const gasEstimate = await publicClient.estimateContractGas({
        address: contractAddr,
        abi: LIQUIDATOR_ABI,
        functionName: 'liquidate',
        args: [collateralAsset, debtAsset, borrower, debtAmount, poolFee, minProfit],
        account,
      });

      const gasPrice = await publicClient.getGasPrice();
      const gasCostWei = gasEstimate * gasPrice;
      const gasCostUsd = Number(gasCostWei) / 1e18 * 3500;

      if (gasCostUsd > parseFloat(process.env.MAX_GAS_PER_TX_USD || '0.50')) {
        logger.warn(`gas too high: $${gasCostUsd.toFixed(4)} for opp #${opp.id}`);
        await db.query(`UPDATE opportunities SET status='rejected', decided_by='gas-too-high' WHERE id=$1`, [opp.id]);
        continue;
      }

      // Execute
      const hash = await walletClient.writeContract({
        address: contractAddr,
        abi: LIQUIDATOR_ABI,
        functionName: 'liquidate',
        args: [collateralAsset, debtAsset, borrower, debtAmount, poolFee, minProfit],
        gas: gasEstimate * 120n / 100n, // 20% buffer
      });

      logger.info(`tx submitted: ${hash}`);
      await db.query(`INSERT INTO executions (opportunity_id, chain, tx_hash, tx_status) VALUES ($1,$2,$3,'pending')`,
        [opp.id, chain, hash]);
      await db.query(`UPDATE opportunities SET status='executed' WHERE id=$1`, [opp.id]);

      // Wait for receipt
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      const success = receipt.status === 'success';
      const gasUsed = Number(receipt.gasUsed);
      const actualGasCost = gasUsed * Number(gasPrice) / 1e18 * 3500;

      await logSpend({ resource: 'eth_gas', amountUsd: actualGasCost, chain, txHash: hash, purpose: `liquidation #${opp.id}` });
      await db.query(`UPDATE executions SET tx_status=$1, gas_used=$2, gas_cost_usd=$3, confirmed_at=NOW() WHERE tx_hash=$4`,
        [success ? 'success' : 'reverted', gasUsed, actualGasCost, hash]);

      if (success) {
        const profit = opp.expected_net_profit_usd;
        await db.query(`UPDATE executions SET actual_profit_usd=$1 WHERE tx_hash=$2`, [profit, hash]);
        await notify(`✅ *Liquidation success!*\nChain: ${chain}\nTx: \`${hash.slice(0,20)}...\`\nProfit: ~$${profit}\nGas: $${actualGasCost.toFixed(4)}`);
      } else {
        await notify(`❌ *Liquidation reverted*\nChain: ${chain}\nTx: \`${hash.slice(0,20)}...\`\nGas burned: $${actualGasCost.toFixed(4)}`);
      }

    } catch (e) {
      logger.error(`execute failed opp #${opp.id}: ${e.message}`);
      await db.query(`UPDATE opportunities SET status='failed' WHERE id=$1`, [opp.id]);
      await notify(`❌ *Execute error* #${opp.id}: ${e.message.slice(0, 100)}`);
    }
  }
}
