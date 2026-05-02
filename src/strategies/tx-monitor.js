import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { db } from '../lib/budget.js';
import { notify } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

const STUCK_THRESHOLD_MINUTES = 5;
const RPC_HEALTH_CHECK_INTERVAL = 60_000;

let alertedTxs = new Set(); // dedup alerts

async function checkPendingTransactions() {
  try {
    const r = await db.query(`
      SELECT id, opportunity_id, chain, tx_hash, submitted_at
      FROM executions
      WHERE tx_status = 'pending'
        AND submitted_at < NOW() - INTERVAL '${STUCK_THRESHOLD_MINUTES} minutes'
      ORDER BY submitted_at ASC
      LIMIT 20
    `);

    for (const tx of r.rows) {
      const client = createPublicClient({ chain: CHAIN_DEF[tx.chain], transport: http(getRpc(tx.chain)) });
      try {
        const receipt = await client.getTransactionReceipt({ hash: tx.tx_hash }).catch(() => null);
        if (receipt) {
          const success = receipt.status === 'success';
          await db.query(
            'UPDATE executions SET tx_status=$1, gas_used=$2, confirmed_at=NOW() WHERE tx_hash=$3',
            [success ? 'success' : 'reverted', Number(receipt.gasUsed), tx.tx_hash]
          );
          logger.info('Recovered receipt for ' + tx.tx_hash + ': ' + (success ? 'success' : 'reverted'));
          continue;
        }

        // Still pending after 5+ min — alert once
        if (!alertedTxs.has(tx.tx_hash)) {
          alertedTxs.add(tx.tx_hash);
          const ageMinutes = Math.floor((Date.now() - new Date(tx.submitted_at).getTime()) / 60000);
          await notify('⚠️ *TX stuck*\nChain: ' + tx.chain + '\nAge: ' + ageMinutes + 'min\nHash: `' + tx.tx_hash + '`');
          logger.warn('stuck tx alerted: ' + tx.tx_hash);
        }

        // After 30 min → mark as dropped
        if (Date.now() - new Date(tx.submitted_at).getTime() > 30 * 60 * 1000) {
          await db.query('UPDATE executions SET tx_status=$1 WHERE tx_hash=$2', ['dropped', tx.tx_hash]);
          await db.query('UPDATE opportunities SET status=$1 WHERE id=$2', ['failed', tx.opportunity_id]);
          alertedTxs.delete(tx.tx_hash);
        }
      } catch (e) {
        logger.warn('tx check ' + tx.tx_hash + ': ' + e.message);
      }
    }
  } catch (e) {
    logger.error('checkPendingTransactions: ' + e.message);
  }
}

async function checkRpcHealth() {
  for (const chain of ['base', 'arbitrum', 'optimism']) {
    const rpc = getRpc(chain);
    if (!rpc) continue;
    try {
      const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(rpc, { timeout: 5000 }) });
      const start = Date.now();
      const blockNumber = await client.getBlockNumber();
      const latency = Date.now() - start;

      if (latency > 3000) {
        logger.warn('RPC slow ' + chain + ': ' + latency + 'ms (block ' + blockNumber + ')');
      }
    } catch (e) {
      logger.error('RPC unhealthy ' + chain + ': ' + e.message);
      await notify('⚠️ Primary RPC down for ' + chain + '\nAuto-failover to Infura backups active.');
    }
  }
}

async function checkBalanceThresholds() {
  // Alert if wallet ETH balance drops below safe threshold
  for (const chain of ['base', 'arbitrum', 'optimism']) {
    try {
      const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
      const bal = await client.getBalance({ address: process.env.ETH_ADDRESS });
      const ethBal = Number(bal) / 1e18;
      const usdValue = ethBal * 3500;

      if (usdValue < 1.0 && usdValue > 0) {
        const key = 'low_balance:' + chain;
        if (!alertedTxs.has(key)) {
          alertedTxs.add(key);
          await notify('⚠️ Low balance on ' + chain + ': $' + usdValue.toFixed(2));
          // Reset alert after 1 hour
          setTimeout(() => alertedTxs.delete(key), 60 * 60 * 1000);
        }
      }
    } catch {}
  }
}

async function cycle() {
  await checkPendingTransactions();
  await checkRpcHealth();
  await checkBalanceThresholds();
}

async function main() {
  logger.info('tx-monitor starting');
  await cycle();
  setInterval(cycle, RPC_HEALTH_CHECK_INTERVAL);
}

main().catch(e => { logger.error('fatal', e); process.exit(1); });
