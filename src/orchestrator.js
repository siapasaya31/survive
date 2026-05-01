import 'dotenv/config';
import { scanDexArb } from './strategies/dex-arb.js';
import { scanLiquidations } from './strategies/liquidation.js';
import { db, emergencyStopTriggered, survivalReport, daysRemaining } from './lib/budget.js';
import { requestApproval, alertCritical, reportSurvival } from './lib/telegram.js';
import { logger } from './lib/logger.js';

const SCAN_INTERVAL_MS = (parseInt(process.env.SCAN_INTERVAL_SECONDS || '60', 10)) * 1000;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const DAILY_REPORT_HOUR = 8;

let halted = false;
let lastDailyReport = 0;

async function runScanners() {
  const stop = await emergencyStopTriggered();
  if (stop.stopped) {
    if (!halted) {
      halted = true;
      await alertCritical('Emergency stop triggered', stop.reason);
    }
    return;
  }

  if (halted && !stop.stopped) {
    halted = false;
    logger.info('emergency stop cleared, resuming scans');
  }

  const results = await Promise.allSettled([
    scanDexArb(),
    scanLiquidations(),
  ]);
  for (const [i, r] of results.entries()) {
    const name = ['dex-arb', 'liquidation'][i];
    if (r.status === 'fulfilled') {
      logger.debug(`${name} done`, r.value);
    } else {
      logger.error(`${name} failed: ${r.reason?.message}`);
    }
  }
}

async function processTriaged() {
  const r = await db.query(`
    SELECT * FROM opportunities
    WHERE status = 'triaged'
    ORDER BY expected_net_profit_usd DESC
    LIMIT 5
  `);

  for (const opp of r.rows) {
    opp.sim_result = { success: true, notes: 'simulation skipped (DRY_RUN ' + process.env.DRY_RUN + ')' };

    await db.query(`UPDATE opportunities SET sim_result=$1, status='simulated' WHERE id=$2`,
      [JSON.stringify(opp.sim_result), opp.id]);

    if (process.env.HUMAN_APPROVAL_REQUIRED !== 'false') {
      await requestApproval(opp);
    } else {
      await db.query(`UPDATE opportunities SET status='approved', decided_by='auto' WHERE id=$1`, [opp.id]);
    }
  }
}

async function expirePending() {
  const r = await db.query(`
    UPDATE opportunities SET status='expired'
    WHERE status='pending_approval' AND discovered_at < NOW() - INTERVAL '5 minutes'
    RETURNING id
  `);
  if (r.rowCount > 0) logger.info(`expired ${r.rowCount} stale approvals`);
}

async function maybeDailyReport() {
  const now = new Date();
  if (now.getHours() === DAILY_REPORT_HOUR && Date.now() - lastDailyReport > 23 * 3600 * 1000) {
    const report = await survivalReport();
    await reportSurvival(report);
    lastDailyReport = Date.now();

    const days = daysRemaining();
    if (days < 7 && parseFloat(report.netUsd) < 20) {
      await alertCritical('Survival warning',
        `${days.toFixed(1)} days left, net only $${report.netUsd}. Reconsider strategy.`);
    }
  }
}

async function loop() {
  try {
    await runScanners();
    await processTriaged();
    await expirePending();
    await maybeDailyReport();
  } catch (e) {
    logger.error(`orchestrator loop error: ${e.message}`, { stack: e.stack });
  }
}

async function main() {
  logger.info('orchestrator starting', {
    deadline: process.env.DEADLINE,
    daysRemaining: daysRemaining().toFixed(1),
    dryRun: process.env.DRY_RUN,
    approvalRequired: process.env.HUMAN_APPROVAL_REQUIRED,
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down');
    await db.end();
    process.exit(0);
  });

  await loop();
  setInterval(loop, SCAN_INTERVAL_MS);
}

main().catch(e => {
  logger.error('fatal error', { error: e.message, stack: e.stack });
  process.exit(1);
});
