import 'dotenv/config';
import { getBot } from '../lib/telegram.js';
import { db } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

const APPROVE_RE = /^\/approve_(\d+)$/;
const REJECT_RE = /^\/reject_(\d+)$/;
const STATUS_RE = /^\/status$/;
const HALT_RE = /^\/halt$/;

export function startListener() {
  const bot = getBot(true);
  if (!bot) {
    logger.error('cannot start telegram listener - no bot token');
    return;
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;

  bot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== chatId) {
      logger.warn(`ignored msg from unauthorized chat ${msg.chat.id}`);
      return;
    }

    const text = (msg.text || '').trim();

    let m = text.match(APPROVE_RE);
    if (m) {
      const oppId = parseInt(m[1], 10);
      const r = await db.query(
        `UPDATE opportunities SET status='approved', decided_at=NOW(), decided_by='telegram'
         WHERE id=$1 AND status='pending_approval' RETURNING id, strategy, chain`,
        [oppId]
      );
      if (r.rowCount === 0) {
        await bot.sendMessage(chatId, `❌ #${oppId} not pending or already decided`);
      } else {
        await bot.sendMessage(chatId, `✅ #${oppId} approved (${r.rows[0].strategy} on ${r.rows[0].chain}). Executor will broadcast next cycle.`);
        logger.info(`opportunity ${oppId} approved`);
      }
      return;
    }

    m = text.match(REJECT_RE);
    if (m) {
      const oppId = parseInt(m[1], 10);
      const r = await db.query(
        `UPDATE opportunities SET status='rejected', decided_at=NOW(), decided_by='telegram'
         WHERE id=$1 AND status='pending_approval' RETURNING id`,
        [oppId]
      );
      if (r.rowCount === 0) {
        await bot.sendMessage(chatId, `❌ #${oppId} not pending`);
      } else {
        await bot.sendMessage(chatId, `🚫 #${oppId} rejected`);
        logger.info(`opportunity ${oppId} rejected`);
      }
      return;
    }

    if (STATUS_RE.test(text)) {
      const { survivalReport } = await import('../lib/budget.js');
      const { reportSurvival } = await import('../lib/telegram.js');
      const report = await survivalReport();
      await reportSurvival(report);
      return;
    }

    if (HALT_RE.test(text)) {
      await db.query(
        `UPDATE opportunities SET status='rejected', decided_at=NOW(), decided_by='halt'
         WHERE status IN ('triaged','simulated','pending_approval')`
      );
      await bot.sendMessage(chatId, `🛑 emergency halt: all pending opportunities rejected`);
      logger.warn('emergency halt triggered via telegram');
      return;
    }
  });

  logger.info('telegram listener started');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startListener();
}
