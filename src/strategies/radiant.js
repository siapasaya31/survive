import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { arbitrum } from 'viem/chains';
import { logger } from '../lib/logger.js';

export const RADIANT_LENDING_POOL = {
  arbitrum: '0xF4B1486DD74D07706052A33d31d7c0AAFD0659E1',
};

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
    { type: 'uint256', indexed: false, name: 'borrowRateMode' },
    { type: 'uint256', indexed: false, name: 'borrowRate' },
    { type: 'uint16',  indexed: true,  name: 'referral' },
  ],
}];

export async function checkRadiantLiquidatable(user) {
  const client = createPublicClient({ chain: arbitrum, transport: http(process.env.RPC_ARBITRUM) });
  try {
    const data = await client.readContract({
      address: RADIANT_LENDING_POOL.arbitrum, abi: POOL_ABI,
      functionName: 'getUserAccountData', args: [user],
    });
    const hf = Number(data[5]) / 1e18;
    if (hf >= 1.0 || hf === 0) return null;
    const collEth = Number(data[0]) / 1e18;
    const debtEth = Number(data[1]) / 1e18;
    return { borrower: user, healthFactor: hf, collateralEth: collEth, debtEth, protocol: 'radiant' };
  } catch { return null; }
}

export function subscribeRadiantEvents(wsClient, onLiquidatable) {
  wsClient.watchContractEvent({
    address: RADIANT_LENDING_POOL.arbitrum,
    abi: BORROW_ABI,
    eventName: 'Borrow',
    onLogs: async (logs) => {
      for (const log of logs) {
        const u = log.args.onBehalfOf;
        if (!u) continue;
        const r = await checkRadiantLiquidatable(u);
        if (r) onLiquidatable('arbitrum', r);
      }
    },
    onError: (e) => logger.warn('Radiant: ' + e.message),
  });
}
