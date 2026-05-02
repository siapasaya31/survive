import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

// Curve V2 pools to monitor for imbalance
const CURVE_V2_POOLS = {
  arbitrum: [
    { name: 'tricrypto2', addr: '0x960ea3e3C7FB317332d990873d354E18d7645590' },
  ],
  optimism: [
    { name: 'tricrypto', addr: '0x0fb0986d3d603b3a18B73CD4b3F95F86D717D9a3' },
  ],
};

const CURVE_V2_ABI = parseAbi([
  'function balances(uint256 i) external view returns (uint256)',
  'function get_virtual_price() external view returns (uint256)',
  'function price_oracle(uint256 i) external view returns (uint256)',
  'function last_prices(uint256 i) external view returns (uint256)',
]);

// Velodrome/Aerodrome veNFT
const VEVELO = {
  optimism: '0xFAf8FD17D9840595845582fCB047DF13f006787d',
};

const VENFT_ABI = parseAbi([
  'function totalSupply() external view returns (uint256)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function locked(uint256 tokenId) external view returns (int128 amount, uint256 end)',
]);

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

// Check if Curve V2 pool is imbalanced (oracle vs spot price diverge)
export async function scanCurvePools(chain) {
  const pools = CURVE_V2_POOLS[chain] || [];
  const imbalanced = [];

  for (const pool of pools) {
    const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
    try {
      const [oracle1, last1] = await Promise.all([
        client.readContract({ address: pool.addr, abi: CURVE_V2_ABI, functionName: 'price_oracle', args: [0n] }),
        client.readContract({ address: pool.addr, abi: CURVE_V2_ABI, functionName: 'last_prices', args: [0n] }),
      ]);
      const oraclePx = Number(oracle1) / 1e18;
      const lastPx = Number(last1) / 1e18;
      const divergencePct = Math.abs(oraclePx - lastPx) / oraclePx * 100;

      if (divergencePct > 0.3) {
        imbalanced.push({ chain, pool: pool.name, oraclePx, lastPx, divergencePct });
      }
    } catch {}
  }
  return imbalanced;
}

// UniswapX limit orders on Base
export const UNISWAPX_REACTOR = {
  base: '0x000000000000000ed559f21bf9c1d8d9c0a6db89',
};

const ORDER_FILLED_EVENT = [{
  type: 'event', name: 'Fill',
  inputs: [
    { type: 'bytes32', indexed: true, name: 'orderHash' },
    { type: 'address', indexed: true, name: 'filler' },
    { type: 'address', indexed: true, name: 'swapper' },
    { type: 'uint256', indexed: false, name: 'nonce' },
  ],
}];

export function subscribeUniswapXEvents(chain, wsClient, onFilled) {
  const reactor = UNISWAPX_REACTOR[chain];
  if (!reactor) return;
  try {
    wsClient.watchContractEvent({
      address: reactor,
      abi: ORDER_FILLED_EVENT,
      eventName: 'Fill',
      onLogs: async (logs) => {
        for (const log of logs) {
          onFilled(chain, { orderHash: log.args.orderHash, filler: log.args.filler });
        }
      },
      onError: (e) => logger.warn('UniswapX ' + chain + ': ' + e.message),
    });
    logger.info('UniswapX subscribed on ' + chain);
  } catch (e) {
    logger.warn('UniswapX subscribe failed: ' + e.message);
  }
}
