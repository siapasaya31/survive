import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { base, arbitrum, optimism, mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from './logger.js';

function buildRpcPool(chain) {
  const alchemyChain = { base: 'base-mainnet', arbitrum: 'arb-mainnet', optimism: 'opt-mainnet', ethereum: 'eth-mainnet' }[chain];
  const infuraChain  = { base: 'base-mainnet', arbitrum: 'arbitrum-mainnet', optimism: 'optimism-mainnet', ethereum: 'mainnet' }[chain];
  const pool = [];
  if (process.env.ALCHEMY_API_KEY)
    pool.push(`https://${alchemyChain}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`);
  for (let i = 1; i <= 8; i++) {
    const k = process.env[`INFURA_KEY_${i}`];
    if (k) pool.push(`https://${infuraChain}.infura.io/v3/${k}`);
  }
  if (pool.length === 0) throw new Error(`No RPC configured for ${chain}`);
  return pool;
}

const RPC_POOLS = { base: buildRpcPool('base'), arbitrum: buildRpcPool('arbitrum'), optimism: buildRpcPool('optimism'), ethereum: buildRpcPool('ethereum') };
const CHAIN_DEF = { base, arbitrum, optimism, ethereum: mainnet };
export const SUPPORTED_L2 = ['base', 'arbitrum', 'optimism'];

const rotState = {};
function st(chain) { if (!rotState[chain]) rotState[chain] = { idx: 0, failures: {} }; return rotState[chain]; }
function cur(chain) { const s = st(chain); return RPC_POOLS[chain][s.idx % RPC_POOLS[chain].length]; }
function rotate(chain, bad) {
  const s = st(chain);
  s.failures[bad] = (s.failures[bad] || 0) + 1;
  s.idx = (s.idx + 1) % RPC_POOLS[chain].length;
  logger.warn(`RPC rotated [${chain}] → pool[${s.idx}]/${RPC_POOLS[chain].length}`);
}

export async function withRpc(chain, fn, retries = RPC_POOLS[chain].length + 1) {
  for (let i = 0; i < retries; i++) {
    const url = cur(chain);
    const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(url, { timeout: 12000, retryCount: 1 }) });
    try {
      return await fn(client);
    } catch (e) {
      const m = e.message || '';
      const limit = m.includes('429') || m.includes('rate limit') || m.includes('limit exceeded') || m.includes('Too Many Requests');
      const dead  = m.includes('timeout') || m.includes('ECONNRESET') || m.includes('ENOTFOUND');
      if ((limit || dead) && i < retries - 1) { rotate(chain, url); await new Promise(r => setTimeout(r, 600 * (i + 1))); continue; }
      throw e;
    }
  }
}

export function getPublicClient(chain) {
  return createPublicClient({ chain: CHAIN_DEF[chain], transport: http(cur(chain), { timeout: 12000, retryCount: 1 }) });
}

export function getWalletClient(chain) {
  const pk = process.env.ETH_PRIVATE_KEY;
  if (!pk || !pk.startsWith('0x')) throw new Error('ETH_PRIVATE_KEY not set');
  return createWalletClient({ account: privateKeyToAccount(pk), chain: CHAIN_DEF[chain], transport: http(cur(chain)) });
}

export async function getBalance(chain, address = process.env.ETH_ADDRESS) {
  return withRpc(chain, async c => Number(await c.getBalance({ address })) / 1e18);
}

export async function totalBalanceUsd(ethPriceUsd = 3500) {
  let total = 0;
  for (const ch of [...SUPPORTED_L2, 'ethereum']) {
    try { total += (await getBalance(ch)) * ethPriceUsd; }
    catch (e) { logger.warn(`balance ${ch}: ${e.message}`); }
  }
  return total;
}

export function rpcStatus() {
  return Object.fromEntries(Object.keys(RPC_POOLS).map(chain => {
    const s = st(chain);
    return [chain, { active: cur(chain).split('/v')[0], idx: s.idx, pool: RPC_POOLS[chain].length, failures: s.failures }];
  }));
}
