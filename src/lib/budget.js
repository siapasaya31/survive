import dotenv from 'dotenv'; dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;
export const db = new Pool({ connectionString: process.env.DATABASE_URL });

export const LIMITS = {
  ANTHROPIC_DAILY: parseFloat(process.env.ANTHROPIC_DAILY_LIMIT_USD || '0.30'),
  ANTHROPIC_TOTAL: parseFloat(process.env.ANTHROPIC_TOTAL_LIMIT_USD || '10.00'),
  MAX_GAS_PER_TX: parseFloat(process.env.MAX_GAS_PER_TX_USD || '0.50'),
  MAX_DAILY_GAS_BURN: parseFloat(process.env.MAX_DAILY_GAS_BURN_USD || '2.00'),
  MIN_NET_PROFIT: parseFloat(process.env.MIN_NET_PROFIT_USD || '2.00'),
  EMERGENCY_STOP_LOSS: parseFloat(process.env.EMERGENCY_STOP_LOSS_USD || '5.00'),
  HOT_WALLET_MAX: parseFloat(process.env.HOT_WALLET_MAX_BALANCE_USD || '15.00'),
  DEADLINE: new Date(process.env.DEADLINE || '2026-05-28T23:59:59Z'),
};

export const PRICING = {
  'claude-sonnet-4-5-20250929': { in: 3.0, out: 15.0 },
  'claude-haiku-3-5': { in: 0.80, out: 4.0 },
  'mimo-v2.5': { in: 0.40, out: 2.0 },
  'mimo-v2.5-pro': { in: 1.0, out: 3.0 },
};

export function calcLLMCost(model, tokensIn, tokensOut) {
  const p = PRICING[model];
  if (!p) {
    logger.warn(`Unknown pricing for model: ${model}`);
    return 0;
  }
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export function daysRemaining() {
  return Math.max(0, (LIMITS.DEADLINE - Date.now()) / 86400000);
}

export async function logSpend({ resource, amountUsd, tokensIn = 0, tokensOut = 0, chain, txHash, purpose }) {
  await db.query(
    `INSERT INTO budget_ledger (resource, amount_usd, tokens_in, tokens_out, chain, tx_hash, purpose)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [resource, amountUsd, tokensIn, tokensOut, chain, txHash, purpose]
  );
}

async function spentInPeriod(resource, hours) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount_usd),0)::float AS s FROM budget_ledger
     WHERE resource=$1 AND ts > NOW() - ($2 || ' hours')::interval`,
    [resource, hours.toString()]
  );
  return r.rows[0].s;
}

async function spentTotal(resource) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount_usd),0)::float AS s FROM budget_ledger WHERE resource=$1`,
    [resource]
  );
  return r.rows[0].s;
}

export async function canSpendAnthropic(estimatedUsd) {
  const today = await spentInPeriod('anthropic', 24);
  const total = await spentTotal('anthropic');
  if (today + estimatedUsd > LIMITS.ANTHROPIC_DAILY) {
    return { ok: false, reason: `daily limit: $${today.toFixed(4)}/$${LIMITS.ANTHROPIC_DAILY}` };
  }
  if (total + estimatedUsd > LIMITS.ANTHROPIC_TOTAL) {
    return { ok: false, reason: `total limit: $${total.toFixed(4)}/$${LIMITS.ANTHROPIC_TOTAL}` };
  }
  return { ok: true, today, total };
}

export async function canSpendGas(estimatedUsd) {
  if (estimatedUsd > LIMITS.MAX_GAS_PER_TX) {
    return { ok: false, reason: `single-tx gas $${estimatedUsd.toFixed(4)} > $${LIMITS.MAX_GAS_PER_TX}` };
  }
  const today = await spentInPeriod('eth_gas', 24);
  if (today + estimatedUsd > LIMITS.MAX_DAILY_GAS_BURN) {
    return { ok: false, reason: `daily gas burn limit: $${today.toFixed(4)}/$${LIMITS.MAX_DAILY_GAS_BURN}` };
  }
  return { ok: true, today };
}

export async function emergencyStopTriggered() {
  const r = await db.query(`
    SELECT
      COALESCE(SUM(gas_cost_usd),0)::float AS gas_burned,
      COALESCE(SUM(actual_profit_usd) FILTER (WHERE tx_status='success'),0)::float AS revenue
    FROM executions WHERE submitted_at > NOW() - INTERVAL '24 hours'
  `);
  const netToday = r.rows[0].revenue - r.rows[0].gas_burned;
  if (netToday < -LIMITS.EMERGENCY_STOP_LOSS) {
    return { stopped: true, reason: `daily net loss $${netToday.toFixed(2)} > emergency limit $${LIMITS.EMERGENCY_STOP_LOSS}` };
  }
  return { stopped: false, netToday };
}

export async function survivalReport() {
  const days = daysRemaining();
  const anthropicSpent = await spentTotal('anthropic');
  const mimoSpent = await spentTotal('mimo');
  const gasSpent = await spentTotal('eth_gas');
  const r = await db.query(`
    SELECT
      COALESCE(SUM(actual_profit_usd) FILTER (WHERE tx_status='success'),0)::float AS revenue,
      COUNT(*) FILTER (WHERE tx_status='success')::int AS wins,
      COUNT(*) FILTER (WHERE tx_status='reverted')::int AS losses
    FROM executions
  `);
  const { revenue, wins, losses } = r.rows[0];
  const netUsd = revenue - gasSpent - anthropicSpent - mimoSpent;

  return {
    daysRemaining: days.toFixed(1),
    spent: {
      anthropic: anthropicSpent.toFixed(4),
      mimo: mimoSpent.toFixed(4),
      gas: gasSpent.toFixed(4),
      total: (anthropicSpent + mimoSpent + gasSpent).toFixed(4),
    },
    revenue: revenue.toFixed(4),
    netUsd: netUsd.toFixed(4),
    txStats: { wins, losses, winRate: wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(1) + '%' : 'n/a' },
    onTrack: netUsd > 0,
  };
}
