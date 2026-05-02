import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

// Detect large pending swaps and calculate post-state arb opportunity
const SWAP_EVENT = [{
  type: 'event', name: 'Swap',
  inputs: [
    { type: 'address', indexed: true, name: 'sender' },
    { type: 'address', indexed: true, name: 'recipient' },
    { type: 'int256',  indexed: false, name: 'amount0' },
    { type: 'int256',  indexed: false, name: 'amount1' },
    { type: 'uint160', indexed: false, name: 'sqrtPriceX96' },
    { type: 'uint128', indexed: false, name: 'liquidity' },
    { type: 'int24',   indexed: false, name: 'tick' },
  ],
}];

const SLOT0_ABI = parseAbi([
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
]);

// High-volume pools per chain (likely backrun candidates)
const POOLS = {
  base: [
    { name: 'WETH/USDC 0.05%',   address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', token0: 'WETH', token1: 'USDC' },
    { name: 'WETH/cbETH 0.05%',  address: '0x10648BA41B8565907Cfa1496765fA4D95390aa0d', token0: 'WETH', token1: 'cbETH' },
    { name: 'USDbC/USDC 0.01%',  address: '0x06959273E9A65433De71F5A452D529544E07dDD0', token0: 'USDbC', token1: 'USDC' },
  ],
  arbitrum: [
    { name: 'WETH/USDC 0.05%',  address: '0xC6962004f452bE9203591991D15f6b388e09E8D0', token0: 'WETH', token1: 'USDC' },
    { name: 'WETH/USDT 0.05%',  address: '0x641C00A822e8b671738d32a431a4Fb6074E5c79d', token0: 'WETH', token1: 'USDT' },
    { name: 'WBTC/WETH 0.05%',  address: '0x2f5e87C9312fa29aed5c179E456625D79015299c', token0: 'WBTC', token1: 'WETH' },
  ],
  optimism: [
    { name: 'WETH/USDC 0.05%',  address: '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b', token0: 'WETH', token1: 'USDC' },
    { name: 'WETH/USDT 0.3%',   address: '0xc858A329Bf053BE78D6239C4A4343B8FbD21472b', token0: 'WETH', token1: 'USDT' },
  ],
};

// Threshold for "large swap" that creates arb opportunity
const LARGE_SWAP_THRESHOLD = {
  base: 3n * 10n ** 18n,      // 3 ETH equivalent
  arbitrum: 3n * 10n ** 18n,
  optimism: 2n * 10n ** 18n,  // smaller threshold for less liquid pools
};

export function subscribeJITBackrun(wsClients, onOpportunity) {
  for (const [chain, pools] of Object.entries(POOLS)) {
    const wsClient = wsClients[chain];
    if (!wsClient) continue;

    for (const pool of pools) {
      try {
        wsClient.watchContractEvent({
          address: pool.address,
          abi: SWAP_EVENT,
          eventName: 'Swap',
          onLogs: async (logs) => {
            for (const log of logs) {
              const a0 = BigInt(log.args.amount0);
              const a1 = BigInt(log.args.amount1);
              const absA0 = a0 < 0n ? -a0 : a0;
              const absA1 = a1 < 0n ? -a1 : a1;

              // Check if this is a large swap (price impact >= threshold)
              const threshold = LARGE_SWAP_THRESHOLD[chain] || 3n * 10n ** 18n;
              if (absA0 > threshold || absA1 > threshold) {
                onOpportunity(chain, {
                  pool: pool.name,
                  poolAddress: pool.address,
                  amount0: a0.toString(),
                  amount1: a1.toString(),
                  sqrtPriceX96: log.args.sqrtPriceX96.toString(),
                  tick: log.args.tick,
                  txHash: log.transactionHash,
                  blockNumber: log.blockNumber?.toString(),
                });
              }
            }
          },
          onError: (e) => logger.warn('JIT ' + chain + '/' + pool.name + ': ' + e.message),
        });
      } catch (e) {
        logger.warn('JIT subscribe failed ' + pool.name + ': ' + e.message);
      }
    }
    logger.info('JIT backrun subscribed ' + chain + ': ' + pools.length + ' pools');
  }
}

// Compare price across multiple DEXes for same pair → detect arb
export async function findCrossDexArb(chain, pair) {
  // Placeholder for now — needs Uniswap V3, Aerodrome, Sushiswap pool addresses per pair
  return null;
}
