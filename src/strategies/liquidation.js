import 'dotenv/config';
import { createHash } from 'crypto';
import { getPublicClient } from '../lib/chains.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { db } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

const AAVE_V3_POOL = {
  base: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

const AAVE_DATA_PROVIDER = {
  base: '0x2A0979257105834789bC6b9E1B00446DFbA8dFBa',
  arbitrum: '0x6b4E260b765B3cA1514e618C0215A6B7839fF93e',
  optimism: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
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

const TRIAGE_PROMPT = `You evaluate Aave V3 liquidation opportunities for a $20-budget micro-liquidator.
Liquidations under $50 collateral are unprofitable. Liquidations over $1000 are taken by pro bots in same block.
Sweet spot: $50-500 collateral, health factor 0.95-1.0 (about to drop below 1).
Score 0-100 based on: profit margin (40pts), competition (30pts), gas-to-profit ratio (30pts).
Output STRICT JSON:
{"score": <int>, "reasoning": "<1 sentence>", "expected_bonus_usd": <float>, "competition_risk": "<low|medium|high>"}`;

async function getRecentBorrowers(chain, blockLookback = 1000) {
  const client = getPublicClient(chain);
  const latest = await client.getBlockNumber();
  const fromBlock = latest - BigInt(blockLookback);

  const logs = await client.getLogs({
    address: AAVE_V3_POOL[chain],
    event: {
      type: 'event',
      name: 'Borrow',
      inputs: [
        { type: 'address', indexed: true, name: 'reserve' },
        { type: 'address', indexed: false, name: 'user' },
        { type: 'address', indexed: true, name: 'onBehalfOf' },
        { type: 'uint256', indexed: false, name: 'amount' },
        { type: 'uint8',   indexed: false, name: 'interestRateMode' },
        { type: 'uint256', indexed: false, name: 'borrowRate' },
        { type: 'uint16',  indexed: true, name: 'referralCode' },
      ],
    },
    fromBlock,
    toBlock: latest,
  });

  return [...new Set(logs.map(l => l.args.onBehalfOf).filter(Boolean))];
}

async function checkHealth(chain, userAddress) {
  const client = getPublicClient(chain);
  try {
    const data = await client.readContract({
      address: AAVE_V3_POOL[chain],
      abi: POOL_ABI,
      functionName: 'getUserAccountData',
      args: [userAddress],
    });
    const totalCollateralUsd = Number(data[0]) / 1e8;
    const totalDebtUsd = Number(data[1]) / 1e8;
    const healthFactor = Number(data[5]) / 1e18;
    return { totalCollateralUsd, totalDebtUsd, healthFactor };
  } catch (e) {
    return null;
  }
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
        users = await getRecentBorrowers(chain, 500);
      } catch (e) {
        logger.warn(`failed to get borrowers on ${chain}: ${e.message}`);
        continue;
      }
      logger.info(`${chain}: checking ${users.length} recent borrowers`);

      for (const user of users.slice(0, 30)) {
        scanned++;
        const health = await checkHealth(chain, user);
        if (!health) continue;
        if (health.healthFactor === 0 || health.healthFactor > 1.05) continue;
        if (health.totalCollateralUsd < 50 || health.totalCollateralUsd > 800) continue;

        const client = getPublicClient(chain);
        const blockNum = await client.getBlockNumber();
        const fp = fingerprint(chain, user, blockNum);
        const exists = await db.query(`SELECT id FROM opportunities WHERE fingerprint=$1`, [fp]);
        if (exists.rows.length > 0) continue;

        const candidate = {
          chain,
          user,
          collateralUsd: health.totalCollateralUsd,
          debtUsd: health.totalDebtUsd,
          healthFactor: health.healthFactor,
        };

        const triage = await mimoChat({
          messages: [
            { role: 'system', content: TRIAGE_PROMPT },
            { role: 'user', content: JSON.stringify(candidate) },
          ],
          agent: 'liquidation',
          purpose: 'triage',
          maxTokens: 256,
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
            triage_score, expected_gross_profit_usd, expected_gas_cost_usd,
            expected_net_profit_usd, status)
          VALUES ('liquidation',$1,$2,$3,$4,$5,$6,$7,$8,'triaged')
        `, [chain, blockNum.toString(), fp, JSON.stringify({ ...candidate, judgment }),
            judgment.score, grossUsd, gasUsd, netUsd]);
        opps++;
        logger.info(`liquidation candidate: ${chain} hf=${health.healthFactor.toFixed(4)} net=$${netUsd.toFixed(4)}`);
      }
    }

    await db.query(`UPDATE scanner_runs SET ended_at=NOW(), items_scanned=$1, items_triaged=$2,
      opportunities_created=$3, cost_usd=$4 WHERE id=$5`,
      [scanned, triaged, opps, cost, runId]);

    return { scanned, triaged, opps, cost, durationMs: Date.now() - runStart };
  } catch (e) {
    await db.query(`UPDATE scanner_runs SET ended_at=NOW(), error=$1 WHERE id=$2`, [e.message, runId]);
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scanLiquidations()
    .then(r => { logger.info('liquidation scan complete', r); process.exit(0); })
    .catch(e => { logger.error('liquidation scan failed', e); process.exit(1); });
}
