import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

// All Aave V3 forks share the same getUserAccountData interface
export const AAVE_FORKS = [
  // Seamless Protocol on Base
  { name: 'Seamless',  chain: 'base',     pool: '0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7' },
  // Moonwell on Base (Compound V2 fork actually, but checking via different ABI)
  // Granary on Optimism
  { name: 'Granary',   chain: 'optimism', pool: '0xB702cE183b4E1Faa574834715E5D4a6378D0eEd3' },
  // Sonne on Optimism (Compound V2 fork - separate handling needed)
  // Tarot - LP collateral, separate logic
];

const POOL_ABI = parseAbi([
  'function getUserAccountData(address user) external view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
]);

const BORROW_ABI = [{
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
}];

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

export async function checkForkLiquidatable(fork, user) {
  const client = createPublicClient({ chain: CHAIN_DEF[fork.chain], transport: http(getRpc(fork.chain)) });
  try {
    const data = await client.readContract({
      address: fork.pool, abi: POOL_ABI,
      functionName: 'getUserAccountData', args: [user],
    });
    const hf = Number(data[5]) / 1e18;
    if (hf >= 1.0 || hf === 0) return null;
    const collUsd = Number(data[0]) / 1e8;
    const debtUsd = Number(data[1]) / 1e8;
    return {
      borrower: user,
      healthFactor: hf,
      collateralUsd: collUsd,
      debtUsd,
      protocol: fork.name.toLowerCase(),
      poolAddress: fork.pool,
    };
  } catch { return null; }
}

export function subscribeAllForkEvents(wsClients, onLiquidatable) {
  for (const fork of AAVE_FORKS) {
    const wsClient = wsClients[fork.chain];
    if (!wsClient) continue;
    try {
      wsClient.watchContractEvent({
        address: fork.pool,
        abi: BORROW_ABI,
        eventName: 'Borrow',
        onLogs: async (logs) => {
          for (const log of logs) {
            const u = log.args.onBehalfOf;
            if (!u) continue;
            const r = await checkForkLiquidatable(fork, u);
            if (r) onLiquidatable(fork.chain, r);
          }
        },
        onError: (e) => logger.warn(fork.name + ' watch: ' + e.message),
      });
      logger.info(fork.name + ' subscribed on ' + fork.chain);
    } catch (e) {
      logger.warn(fork.name + ' subscribe failed: ' + e.message);
    }
  }
}
