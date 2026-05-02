import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { db } from '../lib/budget.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { autoLiquidate } from './executor.js';
import { notify } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';
import { scanGearboxAccounts, GEARBOX_CREDIT_MANAGERS } from './gearbox.js';
import { checkNotionalLiquidatable, NOTIONAL_V3 } from './notional.js';
import { checkStaleOracles, checkOracleDivergence } from './stale-oracle.js';
import { scanCurvePools } from './curve-velo-edge.js';

const TRIAGE_PROMPT = 'Evaluate liquidation. Modal $20. Score 0-100. STRICT JSON:\n{"score":<int>,"reasoning":"<1 sentence>","expected_bonus_usd":<float>}';

async function processOpp(chain, protocol, data) {
  const triage = await mimoChat({
    messages: [
      { role: 'system', content: TRIAGE_PROMPT },
      { role: 'user', content: JSON.stringify({ chain, protocol, ...data }, (_,v) => typeof v === 'bigint' ? v.toString() : v) },
    ],
    agent: 'v8-scanner', purpose: 'triage', maxTokens: 200,
  });
  const j = parseJSON(triage.text);
  if (!j || j.score < 60) return;

  const gross = j.expected_bonus_usd || 5;
  const gas = 0.20;
  const net = gross - gas;
  if (net < parseFloat(process.env.MIN_NET_PROFIT_USD || '0.50')) return;

  const fp = 'v8:' + chain + ':' + protocol + ':' + (data.borrower || data.address) + ':' + Math.floor(Date.now()/30000);
  const exists = await db.query('SELECT id FROM opportunities WHERE fingerprint=$1', [fp]);
  if (exists.rows.length > 0) return;

  const r = await db.query(
    'INSERT INTO opportunities (strategy, chain, fingerprint, raw_data, triage_score, expected_gross_profit_usd, expected_gas_cost_usd, expected_net_profit_usd, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [protocol + '_liq', chain, fp, JSON.stringify({...data, j}, (_,v) => typeof v === 'bigint' ? v.toString() : v), j.score, gross, gas, net, 'triaged']
  );

  const opp = r.rows[0];
  logger.info('v8 opp #' + opp.id + ' ' + protocol + ' net=$' + net.toFixed(4));
  await autoLiquidate(opp);
}

async function cycle() {
  logger.info('v8-scanner cycle start');

  // 1. Gearbox liquidations
  for (const chain of ['arbitrum']) {
    if (!GEARBOX_CREDIT_MANAGERS[chain]?.length) continue;
    try {
      const liquidatable = await scanGearboxAccounts(chain);
      logger.info('Gearbox ' + chain + ': ' + liquidatable.length + ' liquidatable');
      for (const l of liquidatable) await processOpp(chain, 'gearbox', l);
    } catch (e) { logger.warn('Gearbox ' + chain + ': ' + e.message); }
  }

  // 2. Notional (sample known borrowers via events)
  // Skipping account discovery for now — needs separate event scanner

  // 3. Stale oracle alerts
  for (const chain of ['base', 'arbitrum', 'optimism']) {
    try {
      const stale = await checkStaleOracles(chain);
      for (const s of stale) {
        await notify('⚠️ Stale oracle: ' + s.feed + ' on ' + s.chain + ' age=' + Math.floor(s.ageSeconds/60) + 'min (heartbeat=' + Math.floor(s.heartbeat/60) + 'min)');
      }
      const divergences = await checkOracleDivergence(chain);
      for (const d of divergences) {
        await notify('⚠️ Oracle divergence: ' + d.feed + ' on ' + d.chain + ' oracle=$' + d.oraclePrice.toFixed(2) + ' cex=$' + d.cexPrice.toFixed(2) + ' (' + d.divergencePct.toFixed(2) + '%)');
      }
    } catch (e) { logger.warn('oracle ' + chain + ': ' + e.message); }
  }

  // 4. Curve V2 imbalance
  for (const chain of ['arbitrum', 'optimism']) {
    try {
      const imbalanced = await scanCurvePools(chain);
      for (const i of imbalanced) {
        logger.info('Curve imbalanced: ' + i.pool + ' on ' + i.chain + ' divergence=' + i.divergencePct.toFixed(2) + '%');
      }
    } catch {}
  }
}

async function main() {
  logger.info('v8-scanner starting (Gearbox + Notional + StaleOracle + CurveV2)');
  await cycle();
  setInterval(cycle, 5 * 60 * 1000);
}

main().catch(e => { logger.error('fatal', e); process.exit(1); });
