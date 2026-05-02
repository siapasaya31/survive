import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, webSocket } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { db } from '../lib/budget.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { subscribePositionEvents, getLiquidatablePositions, scanStoredPositions } from '../lib/positions.js';
import { autoLiquidate } from '../strategies/executor.js';

const CHAIN_DEF = { base, arbitrum, optimism };

const WSS = {
  base:     'wss://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  arbitrum: 'wss://arb-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
  optimism: 'wss://opt-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_API_KEY,
};

const CHAINLINK_FEED = {
  base:     '0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70',
  arbitrum: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
  optimism: '0x13e3Ee699D1909E989722E753853AE30b17e08c5',
};

const ANSWER_UPDATED_ABI = [{ type: 'event', name: 'AnswerUpdated', inputs: [{ type: 'int256', indexed: true, name: 'current' }, { type: 'uint256', indexed: true, name: 'roundId' }, { type: 'uint256', indexed: false, name: 'updatedAt' }] }];

const TRIAGE_PROMPT = 'Evaluate Aave V3 liquidation. Sweet spot: $50-500 collateral, HF 0.95-1.0.\nScore 0-100. Output STRICT JSON only:\n{"score":<int>,"reasoning":"<1 sentence>","expected_bonus_usd":<float>,"competition_risk":"<low|medium|high>"}';

let lastEthPrice = { base: 0, arbitrum: 0, optimism: 0 };
const processingSet = new Set();

async function handleLiquidatable(chain, borrower, position) {
  const key = chain + ':' + borrower;
  if (processingSet.has(key)) return;
  processingSet.add(key);

  try {
    const collUsd = position.collateralUsd || parseFloat(position.collateral_usd) || 0;
    const debtUsd = position.debtUsd || parseFloat(position.debt_usd) || 0;
    const hf = position.hf || parseFloat(position.health_factor) || 0;

    if (collUsd < 50 || collUsd > 800) return;

    const triage = await mimoChat({
      messages: [
        { role: 'system', content: TRIAGE_PROMPT },
        { role: 'user', content: JSON.stringify({ chain, user: borrower, collateralUsd: collUsd, debtUsd, healthFactor: hf }) },
      ],
      agent: 'ws-monitor', purpose: 'triage', maxTokens: 200,
    });

    const j = parseJSON(triage.text);
    if (!j || j.score < 65) return;

    const gross = j.expected_bonus_usd || (collUsd * 0.05);
    const gas = 0.15;
    const net = gross - gas;
    if (net < parseFloat(process.env.MIN_NET_PROFIT_USD || '2')) return;

    const fp = 'ws:' + chain + ':' + borrower + ':' + Math.floor(Date.now()/30000);
    const exists = await db.query('SELECT id FROM opportunities WHERE fingerprint=$1', [fp]);
    if (exists.rows.length > 0) return;

    const r = await db.query(
      'INSERT INTO opportunities (strategy, chain, fingerprint, raw_data, triage_score, expected_gross_profit_usd, expected_gas_cost_usd, expected_net_profit_usd, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      ['liquidation', chain, fp, JSON.stringify({ user: borrower, collateralUsd: collUsd, debtUsd, hf, j }), j.score, gross, gas, net, 'triaged']
    );

    const opp = r.rows[0];
    logger.info('opportunity #' + opp.id + ' ' + chain + ' hf=' + hf.toFixed(4) + ' net=$' + net.toFixed(4));

    const result = await autoLiquidate(opp);
    if (result.skipped) logger.info('#' + opp.id + ' skipped: ' + result.reason);
  } finally {
    setTimeout(() => processingSet.delete(key), 30000);
  }
}

async function onPriceUpdate(chain, newPriceUsd) {
  const prev = lastEthPrice[chain];
  const drop = prev > 0 ? (prev - newPriceUsd) / prev * 100 : 0;
  lastEthPrice[chain] = newPriceUsd;

  logger.info('ETH price [' + chain + ']: $' + newPriceUsd.toFixed(2) + ' drop=' + drop.toFixed(3) + '%');

  if (drop > 0.1) {
    logger.info('price drop ' + drop.toFixed(3) + '% on ' + chain + ' - scanning positions');
    const positions = await getLiquidatablePositions(chain);
    for (const pos of positions) {
      await handleLiquidatable(chain, pos.borrower, pos);
    }
  }
}

async function watchChain(chain) {
  logger.info('ws-monitor starting: ' + chain);
  const wsClient = createPublicClient({
    chain: CHAIN_DEF[chain],
    transport: webSocket(WSS[chain], { reconnect: true, retryCount: 10, retryDelay: 3000 }),
  });

  wsClient.watchContractEvent({
    address: CHAINLINK_FEED[chain],
    abi: ANSWER_UPDATED_ABI,
    eventName: 'AnswerUpdated',
    onLogs: async (logs) => {
      for (const log of logs) {
        const priceUsd = Number(log.args.current) / 1e8;
        if (priceUsd > 100) await onPriceUpdate(chain, priceUsd);
      }
    },
    onError: (e) => logger.warn('Chainlink watch ' + chain + ': ' + e.message),
  });

  subscribePositionEvents(chain, wsClient, handleLiquidatable);
  logger.info('ws-monitor ready: ' + chain);
}

async function periodicScan() {
  for (const chain of ['base', 'arbitrum', 'optimism']) {
    try {
      await scanStoredPositions(chain);
      const positions = await getLiquidatablePositions(chain);
      for (const pos of positions) await handleLiquidatable(chain, pos.borrower, pos);
    } catch (e) {
      logger.error('periodicScan ' + chain + ': ' + e.message);
    }
  }
}

async function main() {
  logger.info('ws-monitor v2 starting');
  await Promise.all(['base', 'arbitrum', 'optimism'].map(watchChain));
  setInterval(periodicScan, 5 * 60 * 1000);
  setTimeout(periodicScan, 30000);
}

main().catch(e => { logger.error('fatal', e); process.exit(1); });
