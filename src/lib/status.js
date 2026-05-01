import 'dotenv/config';
import { db, survivalReport, daysRemaining } from './budget.js';

async function main() {
  console.log('=== RECON AGENT STATUS ===\n');
  const report = await survivalReport();
  console.log(`Days remaining: ${report.daysRemaining}`);
  console.log(`Net P&L:        $${report.netUsd} ${report.onTrack ? '✅' : '⚠️'}\n`);
  console.log('Spent:');
  console.log(`  Anthropic: $${report.spent.anthropic}`);
  console.log(`  MIMO:      $${report.spent.mimo}`);
  console.log(`  Gas:       $${report.spent.gas}\n`);
  console.log(`Revenue:        $${report.revenue}`);
  console.log(`Tx win rate:    ${report.txStats.winRate} (${report.txStats.wins}W / ${report.txStats.losses}L)\n`);

  const opps = await db.query(`
    SELECT status, COUNT(*) as n FROM opportunities GROUP BY status ORDER BY n DESC
  `);
  console.log('Opportunities by status:');
  for (const r of opps.rows) console.log(`  ${r.status.padEnd(20)} ${r.n}`);

  const pending = await db.query(`SELECT COUNT(*) AS n FROM opportunities WHERE status='pending_approval'`);
  console.log(`\nPending your approval: ${pending.rows[0].n}`);

  await db.end();
}

main();
