import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { db, survivalReport } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

async function sendMsg(text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: chatId, text, parse_mode: 'Markdown'})
  });
}

async function poll() {
  let offset = 0;

  // Clear old updates first
  const init = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`).then(r=>r.json());
  if (init.result?.length > 0) {
    offset = init.result[init.result.length - 1].update_id + 1;
  }

  logger.info('telegram listener started, offset=' + offset);

  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();

      for (const update of (data.result || [])) {
        offset = update.update_id + 1;
        const text = update.message?.text?.trim();
        const fromId = update.message?.chat?.id?.toString();

        if (fromId !== chatId) continue;

        logger.info(`received: ${text}`);

        if (text === '/status') {
          const report = await survivalReport();
          const msg = [
            `*Survival Status*`,
            `Days remaining: ${report.daysRemaining}`,
            `Net P&L: $${report.netUsd} ${report.onTrack ? '✅' : '⚠️'}`,
            `Spent: $${report.spent.total} (Anthropic: $${report.spent.anthropic}, MIMO: $${report.spent.mimo}, Gas: $${report.spent.gas})`,
            `Revenue: $${report.revenue}`,
            `Tx: ${report.txStats.wins}W / ${report.txStats.losses}L (${report.txStats.winRate})`,
          ].join('\n');
          await sendMsg(msg);
          continue;
        }

        const approveMatch = text.match(/^\/approve_(\d+)$/);
        if (approveMatch) {
          const id = parseInt(approveMatch[1]);
          const r = await db.query(
            `UPDATE opportunities SET status='approved', decided_at=NOW(), decided_by='telegram'
             WHERE id=$1 AND status='pending_approval' RETURNING id, strategy, chain`,
            [id]
          );
          await sendMsg(r.rowCount > 0 ? `✅ #${id} approved` : `❌ #${id} not found`);
          continue;
        }

        const rejectMatch = text.match(/^\/reject_(\d+)$/);
        if (rejectMatch) {
          const id = parseInt(rejectMatch[1]);
          const r = await db.query(
            `UPDATE opportunities SET status='rejected', decided_at=NOW(), decided_by='telegram'
             WHERE id=$1 AND status='pending_approval' RETURNING id`,
            [id]
          );
          await sendMsg(r.rowCount > 0 ? `🚫 #${id} rejected` : `❌ #${id} not found`);
          continue;
        }

        if (text === '/halt') {
          await db.query(`UPDATE opportunities SET status='rejected' WHERE status='pending_approval'`);
          await sendMsg('🛑 All pending opportunities halted');
          continue;
        }

        if (text === '/help') {
          await sendMsg([
            '*Commands:*',
            '/status - survival report',
            '/approve\\_<id> - approve opportunity',
            '/reject\\_<id> - reject opportunity',
            '/halt - reject all pending',
          ].join('\n'));
        }
      }
    } catch (e) {
      logger.error(`poll error: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

poll().catch(e => { logger.error('fatal', e); process.exit(1); });
