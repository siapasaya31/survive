import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, webSocket, parseAbiItem } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { db } from '../lib/budget.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { requestApproval } from '../lib/telegram.js';
import { createHash } from 'crypto';
import { logger } from '../lib/logger.js';

const WSS = {
  base:     process.env.WSS_BASE     || `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  arbitrum: process.env.WSS_ARBITRUM || `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  optimism: process.env.WSS_OPTIMISM || `wss://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
};

const CHAIN_DEF = { base, arbitrum, optimism };

const AAVE_V3_POOL = {
  base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

const POOL_ABI = [{
  inputs: [{ type: 'address' }],
  name: 'getUserAccountData',
  outputs: [
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  ],
  stateMutability: 'view',
  type: 'function',
}];

const TRIAGE_PROMPT = `Evaluate Aave V3 liquidation. Sweet spot: $50-500 collateral, HF 0.95-1.0.
Score 0-100. Output STRICT JSON only:
{"score":<int>,"reasoning":"<1 sentence>","expected_bonus_usd":<float>,"competition_risk":"<low|medium|high>"}`;

function fp(chain, user) {
  return createHash('sha256').update(`ws-liq:${chain}:${user}:${Math.floor(Date.now()/60000)}`).digest('hex').slice(0,32);
}

async function handleBorrow(chain, client, user) {
  try {
    const data = await client.readContract({
      address: AAVE_V3_POOL[chain], abi: POOL_ABI,
      functionName: 'getUserAccountData', args: [user],
    });
    const collateral = Number(data[0]) / 1e8;
    const debt       = Number(data[1]) / 1e8;
    const hf         = Number(data[5]) / 1e18;

    if (hf === 0 || hf > 1.05) return;
    if (collateral < 50 || collateral > 800) return;

    const fingerprint = fp(chain, user);
    const exists = await db.query('SELECT id FROM opportunities WHERE fingerprint=$1', [fingerprint]);
    if (exists.rows.length > 0) return;

    logger.info(`🔴 real-time liquidation candidate: ${chain} user=${user.slice(0,10)}... hf=${hf.toFixed(4)} collateral=$${collateral.toFixed(2)}`);

    const triage = await mimoChat({
      messages: [
        { role: 'system', content: TRIAGE_PROMPT },
        { role: 'user', content: JSON.stringify({ chain, user, collateral, debt, hf }) },
      ],
      agent: 'ws-monitor', purpose: 'triage', maxTokens: 200,
    });

    const j = parseJSON(triage.text);
    if (!j || j.score < 65) return;

    const gross = j.expected_bonus_usd || collateral * 0.05;
    const gas   = 0.20;
    const net   = gross - gas;
    if (net < parseFloat(process.env.MIN_NET_PROFIT_USD || '2')) return;

    const r = await db.query(`
      INSERT INTO opportunities (strategy, chain, fingerprint, raw_data, triage_score,
        expected_gross_profit_usd, expected_gas_cost_usd, expected_net_profit_usd, status)
      VALUES ('liquidation',$1,$2,$3,$4,$5,$6,$7,'triaged') RETURNING *`,
      [chain, fingerprint, JSON.stringify({user, collateral, debt, hf, j}), j.score, gross, gas, net]
    );
    await requestApproval(r.rows[0]);
  } catch (e) {
    logger.warn(`handleBorrow error: ${e.message}`);
  }
}

async function watchChain(chain) {
  logger.info(`starting WebSocket watcher: ${chain}`);
  const client = createPublicClient({
    chain: CHAIN_DEF[chain],
    transport: webSocket(WSS[chain], { reconnect: true, retryCount: 10, retryDelay: 3000 }),
  });

  // Watch Borrow events real-time
  client.watchContractEvent({
    address: AAVE_V3_POOL[chain],
    abi: [{
      type: 'event', name: 'Borrow',
      inputs: [
        { type: 'address', indexed: true,  name: 'reserve' },
        { type: 'address', indexed: false, name: 'user' },
        { type: 'address', indexed: true,  name: 'onBehalfOf' },
        { type: 'uint256', indexed: false, name: 'amount' },
        { type: 'uint8',   indexed: false, name: 'interestRateMode' },
        { type: 'uint256', indexed: false, name: 'borrowRate' },
        { type: 'uint16',  indexed: true,  name: 'referralCode' },
      ],
    }],
    eventName: 'Borrow',
    onLogs: (logs) => {
      for (const log of logs) {
        const user = log.args.onBehalfOf;
        if (user) handleBorrow(chain, client, user);
      }
    },
    onError: (e) => logger.warn(`${chain} watch error: ${e.message}`),
  });

  // Also watch price oracle updates — price drop = HF drop = liquidation opportunity
  client.watchBlocks({
    onBlock: async (block) => {
      logger.debug(`${chain} block ${block.number}`);
    },
    onError: (e) => logger.warn(`${chain} block watch error: ${e.message}`),
  });
}

async function main() {
  logger.info('WebSocket monitor starting...');
  await Promise.all(['base', 'arbitrum', 'optimism'].map(watchChain));
}

main().catch(e => { logger.error('fatal', e); process.exit(1); });
