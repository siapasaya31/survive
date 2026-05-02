import 'dotenv/config';
import { createHash } from 'crypto';
import { withRpc } from '../lib/chains.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { db } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

const AAVE_V3_POOL = {
  base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

const POOL_ABI = [{
  inputs: [{ type: 'address' }],
  name: 'getUserAccountData',
  outputs: [
    { type: 'uint256', name: 'totalCollateralBase' },
    { type: 'uint256', name: 'totalDebtBase' },
    { type: 'uint256', name: 'availableBorrowsBase' },
    { type: 'uint256', name: 'currentLiquidationThreshold' },
    { type: 'uint256', name: 'ltv' },
    { type: 'uint256', name: 'healthFactor' },
  ],
  stateMutability: 'view',
  type: 'function',
}];

const BORROW_EVENT = {
  type: 'event',
  name: 'Borrow',
  inputs: [
    { type: 'address', indexed: true,  name: 'reserve' },
    { type: 'address', indexed: false, name: 'user' },
    { type: 'address', indexed: true,  name: 'onBehalfOf' },
    { type: 'uint256', indexed: false, name: 'amount' },
    { type: 'uint8',   indexed: false, name: 'interestRateMode' },
    { type: 'uint256', indexed: false, name: 'borrowRate' },
    { type: 'uint16',  indexed: true,  name: 'referralCode' },
  ],
};

const TRIAGE_PROMPT = `You evaluate Aave V3 liquidation opportunities for a micro-liquidator with $20 budget.
Sweet spot: $50-500 collateral, health factor 0.95-1.0.
Score 0-100. Output STRICT JSON:
{"score": <int>, "reasoning": "<1 sentence>", "expected_bonus_usd": <float>, "competition_risk": "<low|medium|high>"}`;

async function getRecentBorrowers(chain) {
  return withRpc(chain, async (client) => {
    const latest = await client.getBlockNumber();
    // Use 500 block chunks, rotate RPC on limit error automatically
    const chunkSize = 500n;
    const totalBlocks = 2000n;
    let allUsers = new Set();

    for (let from = latest - totalBlocks; from < latest; from += chunkSize) {
      const to = from + chunkSize > latest ? latest : from + chunkSize;
      try {
        const logs = await client.getLogs({
          address: AAVE_V3_POOL[chain],
          event: BORROW_EVENT,
          fromBlock: from,
          toBlock: to,
        });
        logs.forEach(l => l.args.onBehalfOf && allUsers.add(l.args.onBehalfOf));
      } catch (e) {
        const m = e.message || '';
        // If block range error, try smaller chunk
        if (m.includes('block range') || m.includes('10 block')) {
          const miniChunk = 10n;
          for (let mf = from; mf < to; mf += miniChunk) {
            const mt = mf + miniChunk > to ? to : mf + miniChunk;
            try {
              const logs = await client.getLogs({
                address: AAVE_V3_POOL[chain],
                event: BORROW_EVENT,
                fromBlock: mf,
                toBlock: mt,
              });
              logs.forEach(l => l.args.onBehalfOf && allUsers.add(l.args.onBehalfOf));
            } catch (_) { /* skip chunk */ }
          }
        }
      }
    }
    return [...allUsers];
  });
}

async function checkHealth(chain, userAddress) {
  return withRpc(chain, async (client) => {
    try {
      const data = await client.readContract({
        address: AAVE_V3_POOL[chain],
        abi: POOL_ABI,
        functionName: 'getUserAccountData',
        args: [userAddress],
      });
      return {
        totalCollateralUsd: Number(data[0]) / 1e8,
        totalDebtUsd: Number(data[1]) / 1e8,
        healthFactor: Number(data[5]) / 1e18,
      };
    } catch { return null; }
  });
}

function fingerprint(chain, user, blockNumber) {
  return createHash('sha256').update(`liq:${chain}:${user}:${Math.floor(Number(blockNumber) / 100)}`).digest('hex').slice(0, 32);
}

export async function scanLiquidations() {
  const runStart = Date.now();
  const r = await db.query(`INSERT INTO scanner_runs (strategy) VALUES ('liquidation') RETURNING id`);
  const runId = r.rows[0].id;
  let scanned = 0, triaged = 0, opps = 0, cost = 0;

  try {
    for (const chain of ['base', 'arbitrum', 'optimism']) {
      let users;
      try {
        users = await getRecentBorrowers(chain);
      } catch (e) {
        logger.warn(`borrowers failed ${chain}: ${e.message}`);
        continue;
      }
      logger.info(`${chain}: ${users.length} borrowers`);

      for (const user of users.slice(0, 40)) {
        scanned++;
        const health = await checkHealth(chain, user);
        if (!health) continue;
        if (health.healthFactor === 0 || health.healthFactor > 1.05) continue;
        if (health.totalCollateralUsd < 50 || health.totalCollateralUsd > 800) continue;

        const blockNum = await withRpc(chain, c => c.getBlockNumber());
        const fp = fingerprint(chain, user, blockNum);
        const exists = await db.query(`SELECT id FROM opportunities WHERE fingerprint=$1`, [fp]);
        if (exists.rows.length > 0) continue;

        const candidate = { chain, user, collateralUsd: health.totalCollateralUsd, debtUsd: health.totalDebtUsd, healthFactor: health.healthFactor };
        const triage = await mimoChat({
          messages: [{ role: 'system', content: TRIAGE_PROMPT }, { role: 'user', content: JSON.stringify(candidate) }],
          agent: 'liquidation', purpose: 'triage', maxTokens: 256,
        });
        cost += triage.cost;
        triaged++;

        const judgment = parseJSON(triage.text);
        if (!judgment || judgment.score < 65) continue;

        const grossUsd = judgment.expected_bonus_usd || (health.totalCollateralUsd * 0.05);
        const gasUsd = 0.20;
        const netUsd = grossUsd - gasUsd;
        if (netUsd < parseFloat(process.env.MIN_NET_PROFIT_USD || '2')) continue;

        await db.query(`
          INSERT INTO opportunities (strategy, chain, block_number, fingerprint, raw_data,
            triage_score, expected_gross_profit_usd, expected_gas_cost_usd, expected_net_profit_usd, status)
          VALUES ('liquidation',$1,$2,$3,$4,$5,$6,$7,$8,'triaged')
        `, [chain, blockNum.toString(), fp, JSON.stringify({ ...candidate, judgment }), judgment.score, grossUsd, gasUsd, netUsd]);
        opps++;
        logger.info(`liquidation: ${chain} hf=${health.healthFactor.toFixed(4)} net=$${netUsd.toFixed(4)}`);
      }
    }

    await db.query(`UPDATE scanner_runs SET ended_at=NOW(), items_scanned=$1, items_triaged=$2, opportunities_created=$3, cost_usd=$4 WHERE id=$5`,
      [scanned, triaged, opps, cost, runId]);
    return { scanned, triaged, opps, cost, durationMs: Date.now() - runStart };
  } catch (e) {
    await db.query(`UPDATE scanner_runs SET ended_at=NOW(), error=$1 WHERE id=$2`, [e.message, runId]);
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scanLiquidations()
    .then(r => { logger.info('done', r); process.exit(0); })
    .catch(e => { logger.error('failed', e); process.exit(1); });
}
