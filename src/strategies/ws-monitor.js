import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, webSocket } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { db } from '../lib/budget.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { subscribePositionEvents, getLiquidatablePositions, scanStoredPositions } from '../lib/positions.js';
import { autoLiquidate } from './executor.js';
import { subscribeCompoundEvents, scanAllCompoundUsers, COMET_USDC } from './compound-v3.js';
import { subscribeMorphoEvents, getActiveMarkets, getActiveBorrowers, checkMorphoLiquidatable, MORPHO_BLUE } from './morpho-blue.js';
import { scanPriceDivergence } from './price-divergence.js';

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

const ANSWER_UPDATED_ABI = [{
  type: 'event', name: 'AnswerUpdated',
  inputs: [
    { type: 'int256',  indexed: true,  name: 'current' },
    { type: 'uint256', indexed: true,  name: 'roundId' },
    { type: 'uint256', indexed: false, name: 'updatedAt' },
  ],
}];

const TRIAGE_PROMPT = 'Evaluate liquidation opportunity. Modal kecil $20. Sweet spot: $50-500 collateral, soon-to-liquidate.\nScore 0-100. Output STRICT JSON:\n{"score":<int>,"reasoning":"<1 sentence>","expected_bonus_usd":<float>}';

let lastEthPrice = { base: 0, arbitrum: 0, optimism: 0 };
const processingSet = new Set();

async function processOpportunity(chain, protocol, data) {
  const key = chain + ':' + protocol + ':' + data.borrower;
  if (processingSet.has(key)) return;
  processingSet.add(key);

  try {
    const triage = await mimoChat({
      messages: [
        { role: 'system', content: TRIAGE_PROMPT },
        { role: 'user', content: JSON.stringify({ chain, protocol, ...data }) },
      ],
      agent: 'ws-monitor', purpose: 'triage', maxTokens: 200,
    });

    const j = parseJSON(triage.text);
    if (!j || j.score < 65) return;

    const gross = j.expected_bonus_usd || 5;
    const gas = 0.20;
    const net = gross - gas;
    if (net < parseFloat(process.env.MIN_NET_PROFIT_USD || '2')) return;

    const fp = 'multi:' + chain + ':' + protocol + ':' + data.borrower + ':' + Math.floor(Date.now()/30000);
    const exists = await db.query('SELECT id FROM opportunities WHERE fingerprint=$1', [fp]);
    if (exists.rows.length > 0) return;

    const r = await db.query(
      'INSERT INTO opportunities (strategy, chain, fingerprint, raw_data, triage_score, expected_gross_profit_usd, expected_gas_cost_usd, expected_net_profit_usd, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [protocol + '_liq', chain, fp, JSON.stringify({ ...data, j }), j.score, gross, gas, net, 'triaged']
    );

    const opp = r.rows[0];
    logger.info('opportunity #' + opp.id + ' ' + protocol + ' ' + chain + ' net=$' + net.toFixed(4));

    const result = await autoLiquidate(opp);
    if (result.skipped) logger.info('#' + opp.id + ' skipped: ' + result.reason);
  } finally {
    setTimeout(() => processingSet.delete(key), 30000);
  }
}

async function handleAaveLiquidatable(chain, borrower, position) {
  const collUsd = position.collateralUsd || parseFloat(position.collateral_usd) || 0;
  const debtUsd = position.debtUsd || parseFloat(position.debt_usd) || 0;
  const hf = position.hf || parseFloat(position.health_factor) || 0;
  if (collUsd < 50 || collUsd > 800) return;
  await processOpportunity(chain, 'aave', { user: borrower, collateralUsd: collUsd, debtUsd, healthFactor: hf });
}

async function handleCompoundLiquidatable(chain, data) {
  await processOpportunity(chain, 'compound', { user: data.borrower, ...data });
}

async function handleMorphoLiquidatable(chain, data) {
  await processOpportunity(chain, 'morpho', { user: data.borrower, ...data });
}

async function onPriceUpdate(chain, newPriceUsd) {
  const prev = lastEthPrice[chain];
  const drop = prev > 0 ? (prev - newPriceUsd) / prev * 100 : 0;
  lastEthPrice[chain] = newPriceUsd;

  if (drop > 0.1) {
    logger.info('ETH drop ' + drop.toFixed(3) + '% on ' + chain);
    // Aave positions
    const positions = await getLiquidatablePositions(chain);
    for (const pos of positions) await handleAaveLiquidatable(chain, pos.borrower, pos);
  }

  // Check cross-chain divergence
  const div = await scanPriceDivergence();
  if (div && div.divergencePct > 0.1) {
    logger.info('cross-chain divergence: scanning ' + div.lowerChain);
    const positions = await getLiquidatablePositions(div.lowerChain);
    for (const pos of positions) await handleAaveLiquidatable(div.lowerChain, pos.borrower, pos);
  }
}

async function watchChain(chain) {
  logger.info('ws-monitor v3 starting: ' + chain);
  const wsClient = createPublicClient({
    chain: CHAIN_DEF[chain],
    transport: webSocket(WSS[chain], { reconnect: true, retryCount: 10, retryDelay: 3000 }),
  });

  // Chainlink price feed
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
    onError: (e) => logger.warn('Chainlink ' + chain + ': ' + e.message),
  });

  // Aave V3 events
  subscribePositionEvents(chain, wsClient, handleAaveLiquidatable);

  // Compound V3 events (only Base + Arbitrum)
  if (COMET_USDC[chain]) {
    subscribeCompoundEvents(chain, wsClient, handleCompoundLiquidatable);
  }

  // Morpho Blue events (only Base)
  if (MORPHO_BLUE[chain]) {
    subscribeMorphoEvents(chain, wsClient, handleMorphoLiquidatable);
  }

  logger.info('ws-monitor v3 ready: ' + chain);
}

async function periodicScan() {
  for (const chain of ['base', 'arbitrum', 'optimism']) {
    try {
      // Aave
      await scanStoredPositions(chain);
      const aavePositions = await getLiquidatablePositions(chain);
      for (const pos of aavePositions) await handleAaveLiquidatable(chain, pos.borrower, pos);

      // Compound
      if (COMET_USDC[chain]) {
        const compoundLiq = await scanAllCompoundUsers(chain);
        for (const data of compoundLiq) await handleCompoundLiquidatable(chain, data);
      }

      // Morpho (Base only)
      if (MORPHO_BLUE[chain]) {
        const markets = await getActiveMarkets(chain);
        for (const mid of markets.slice(0, 10)) {
          const borrowers = await getActiveBorrowers(chain, mid);
          for (const b of borrowers.slice(0, 20)) {
            const result = await checkMorphoLiquidatable(chain, mid, b);
            if (result) await handleMorphoLiquidatable(chain, result);
          }
        }
      }
    } catch (e) {
      logger.error('periodicScan ' + chain + ': ' + e.message);
    }
  }
}

async function main() {
  logger.info('ws-monitor v3 starting (Aave + Compound + Morpho + cross-chain)');
  await Promise.all(['base', 'arbitrum', 'optimism'].map(watchChain));
  setInterval(periodicScan, 5 * 60 * 1000);
  setTimeout(periodicScan, 30000);
}

main().catch(e => { logger.error('fatal', e); process.exit(1); });
