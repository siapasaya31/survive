import 'dotenv/config';
import { createHash } from 'crypto';
import { getPublicClient } from '../lib/chains.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { db } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

const POOLS_BASE = [
  { name: 'WETH/USDC',  uniV3: '0xd0b53D9277642d899DF5C87A3966A349A798F224', aerodrome: '0xcDAC0d6c6C59727a65F871236188350531885C43' },
  { name: 'WETH/cbETH', uniV3: '0x10648BA41B8565907Cfa1496765fA4D95390aa0d', aerodrome: '0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91' },
];

const ERC20_DECIMALS_ABI = [{ inputs: [], name: 'decimals', outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' }];
const UNISWAP_V3_SLOT0_ABI = [{ inputs: [], name: 'slot0', outputs: [
  { type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' },
  { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' },
], stateMutability: 'view', type: 'function' }];
const AERODROME_GETRESERVES_ABI = [{ inputs: [], name: 'getReserves', outputs: [
  { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
], stateMutability: 'view', type: 'function' }];

async function getUniV3Price(client, poolAddr) {
  try {
    const slot0 = await client.readContract({ address: poolAddr, abi: UNISWAP_V3_SLOT0_ABI, functionName: 'slot0' });
    const sqrtPriceX96 = BigInt(slot0[0]);
    const price = Number((sqrtPriceX96 * sqrtPriceX96) / (2n ** 192n));
    return price > 0 ? price : 1 / Number(2n ** 192n / (sqrtPriceX96 * sqrtPriceX96));
  } catch (e) {
    logger.warn(`UniV3 read failed for ${poolAddr}: ${e.message}`);
    return null;
  }
}

async function getAerodromePrice(client, poolAddr) {
  try {
    const reserves = await client.readContract({ address: poolAddr, abi: AERODROME_GETRESERVES_ABI, functionName: 'getReserves' });
    const [r0, r1] = reserves;
    if (BigInt(r0) === 0n || BigInt(r1) === 0n) return null;
    return Number(r1) / Number(r0);
  } catch (e) {
    logger.warn(`Aerodrome read failed for ${poolAddr}: ${e.message}`);
    return null;
  }
}

function fingerprint(strategy, chain, key) {
  return createHash('sha256').update(`${strategy}:${chain}:${key}`).digest('hex').slice(0, 32);
}

const TRIAGE_PROMPT = `You assess DEX arbitrage opportunities for an under-funded micro-trader (max $5 per trade).
Score 0-100 based on: spread size (40pts), liquidity depth (30pts), gas-cost ratio (20pts), competition risk (10pts).
Output STRICT JSON only:
{"score": <int>, "reasoning": "<1 sentence>", "estimated_max_size_usd": <float>, "competition_risk": "<low|medium|high>"}`;

export async function scanDexArb() {
  const runStart = Date.now();
  const r = await db.query(`INSERT INTO scanner_runs (strategy) VALUES ('dex_arb') RETURNING id`);
  const runId = r.rows[0].id;
  let scanned = 0, triaged = 0, opps = 0, cost = 0;

  try {
    const client = getPublicClient('base');

    for (const pool of POOLS_BASE) {
      scanned++;
      const [pUni, pAero] = await Promise.all([
        getUniV3Price(client, pool.uniV3),
        getAerodromePrice(client, pool.aerodrome),
      ]);

      if (!pUni || !pAero) continue;

      const spreadPct = Math.abs(pUni - pAero) / Math.min(pUni, pAero) * 100;
      if (spreadPct < 0.3) continue;

      const fp = fingerprint('dex_arb', 'base', `${pool.name}:${Math.floor(Date.now() / 60000)}`);
      const exists = await db.query(`SELECT id FROM opportunities WHERE fingerprint=$1`, [fp]);
      if (exists.rows.length > 0) continue;

      const candidate = {
        pair: pool.name,
        priceUni: pUni,
        priceAero: pAero,
        spreadPct: spreadPct.toFixed(4),
        chain: 'base',
        liquidityUni: 'unknown',
        liquidityAero: 'unknown',
      };

      const triage = await mimoChat({
        messages: [
          { role: 'system', content: TRIAGE_PROMPT },
          { role: 'user', content: JSON.stringify(candidate) },
        ],
        agent: 'dex-arb',
        purpose: 'triage',
        maxTokens: 256,
      });
      cost += triage.cost;
      triaged++;

      const judgment = parseJSON(triage.text);
      if (!judgment || judgment.score < 60) {
        logger.debug(`skip ${pool.name}: score ${judgment?.score || 'parse-fail'}`);
        continue;
      }

      const grossUsd = Math.min(judgment.estimated_max_size_usd || 5, 5) * (spreadPct / 100);
      const gasUsd = 0.05;
      const netUsd = grossUsd - gasUsd;

      if (netUsd < parseFloat(process.env.MIN_NET_PROFIT_USD || '2')) {
        logger.debug(`skip ${pool.name}: net $${netUsd.toFixed(4)} below threshold`);
        continue;
      }

      await db.query(`
        INSERT INTO opportunities (strategy, chain, fingerprint, raw_data, triage_score,
          expected_gross_profit_usd, expected_gas_cost_usd, expected_net_profit_usd, status)
        VALUES ('dex_arb','base',$1,$2,$3,$4,$5,$6,'triaged')
      `, [fp, JSON.stringify({ ...candidate, judgment }), judgment.score, grossUsd, gasUsd, netUsd]);
      opps++;
      logger.info(`new opportunity: ${pool.name} spread=${spreadPct.toFixed(3)}% net=$${netUsd.toFixed(4)}`);
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
  scanDexArb()
    .then(r => { logger.info('scan complete', r); process.exit(0); })
    .catch(e => { logger.error('scan failed', e); process.exit(1); });
}
