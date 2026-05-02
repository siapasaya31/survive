import { db } from './budget.js';
import { logger } from './logger.js';

const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_AFTER_LOSS_MINUTES || '60', 10);
const REVERT_THRESHOLD = 3;

export async function isInCooldown() {
  const r = await db.query(`
    SELECT COUNT(*)::int AS reverts
    FROM executions
    WHERE tx_status = 'reverted'
      AND submitted_at > NOW() - INTERVAL '${COOLDOWN_MINUTES} minutes'
  `);

  const reverts = r.rows[0].reverts;
  if (reverts >= REVERT_THRESHOLD) {
    const last = await db.query(`
      SELECT MAX(submitted_at) AS last_revert
      FROM executions WHERE tx_status='reverted'
    `);
    const lastRevert = last.rows[0].last_revert;
    const minutesAgo = (Date.now() - new Date(lastRevert).getTime()) / 60000;
    const remaining = Math.max(0, COOLDOWN_MINUTES - minutesAgo);
    return { active: true, reverts, remainingMinutes: remaining.toFixed(1) };
  }
  return { active: false, reverts };
}
