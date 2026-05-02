import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { logger } from '../lib/logger.js';

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

const POOLS_TO_WATCH = {
  base: [
    { name: 'WETH/USDC 0.05%', address: '0xd0b53D9277642d899DF5C87A3966A349A798F224' },
    { name: 'WETH/cbETH 0.05%', address: '0x10648BA41B8565907Cfa1496765fA4D95390aa0d' },
  ],
  arbitrum: [
    { name: 'WETH/USDC 0.05%', address: '0xC6962004f452bE9203591991D15f6b388e09E8D0' },
  ],
  optimism: [
    { name: 'WETH/USDC 0.05%', address: '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b' },
  ],
};

export function subscribeBackrunEvents(chain, wsClient, onLargeSwap) {
  for (const pool of POOLS_TO_WATCH[chain] || []) {
    wsClient.watchContractEvent({
      address: pool.address,
      abi: SWAP_EVENT,
      eventName: 'Swap',
      onLogs: async (logs) => {
        for (const log of logs) {
          const a1 = BigInt(log.args.amount1);
          const absA1 = a1 < 0n ? -a1 : a1;
          if (absA1 > 5n * 10n ** 18n) {
            onLargeSwap(chain, { pool: pool.name, address: pool.address, amount1: a1.toString() });
          }
        }
      },
      onError: (e) => logger.warn('Backrun ' + chain + ': ' + e.message),
    });
  }
}
