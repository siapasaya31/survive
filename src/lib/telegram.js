import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { db } from './budget.js';
import { logger } from './logger.js';

let bot = null;

export function getBot(polling = false) {
  if (bot) return bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN not set - notifications disabled');
    return null;
  }
  bot = new TelegramBot(token, { polling });
  return bot;
}

export async function notify(text, options = {}) {
  const b = getBot();
  if (!b) {
    logger.info(`[NOTIFY] ${text.slice(0, 200)}`);
    return null;
  }
  const trimmed = text.length > 4000 ? text.slice(0, 4000) + '\n... (truncated)' : text;
  try {
    return await b.sendMessage(process.env.TELEGRAM_CHAT_ID, trimmed, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...options,
    });
  } catch (e) {
    logger.error(`Telegram send failed: ${e.message}`);
    return null;
  }
}

export async function requestApproval(opportunity) {
  const lines = [
    `*Opportunity #${opportunity.id}* (${opportunity.strategy})`,
    `Chain: \`${opportunity.chain}\``,
    `Expected gross: $${Number(opportunity.expected_gross_profit_usd).toFixed(4)}`,
    `Expected gas:   $${Number(opportunity.expected_gas_cost_usd).toFixed(4)}`,
    `Expected net:   *$${Number(opportunity.expected_net_profit_usd).toFixed(4)}*`,
    `Triage score:   ${opportunity.triage_score}/100`,
    ``,
    `Sim result: ${opportunity.sim_result?.success ? '✅ profitable' : '❌ failed'}`,
  ];
  if (opportunity.sim_result?.notes) lines.push(`Notes: ${opportunity.sim_result.notes}`);
  lines.push('');
  lines.push(`Reply: \`/approve_${opportunity.id}\` or \`/reject_${opportunity.id}\``);
  lines.push(`Auto-expires in 5 min.`);

  const msg = await notify(lines.join('\n'));
  if (msg) {
    await db.query(
      `UPDATE opportunities SET status='pending_approval', approval_msg_id=$1 WHERE id=$2`,
      [msg.message_id?.toString(), opportunity.id]
    );
  }
  return msg;
}

export async function alertCritical(title, body) {
  return notify(`🚨 *${title}*\n\n${body}`);
}

export async function reportSurvival(report) {
  const lines = [
    `*Daily survival report*`,
    `Days remaining: ${report.daysRemaining}`,
    ``,
    `*Spent:*`,
    `  Anthropic: $${report.spent.anthropic}`,
    `  MIMO:      $${report.spent.mimo}`,
    `  Gas:       $${report.spent.gas}`,
    `  Total:     $${report.spent.total}`,
    ``,
    `*Revenue:* $${report.revenue}`,
    `*Net:*     $${report.netUsd} ${report.onTrack ? '✅' : '⚠️'}`,
    `*Tx:*      ${report.txStats.wins}W / ${report.txStats.losses}L (${report.txStats.winRate})`,
  ];
  return notify(lines.join('\n'));
}
