import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { arbitrum, optimism } from 'viem/chains';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { arbitrum, optimism };

// Pendle V2 Router/Market addresses
export const PENDLE = {
  arbitrum: {
    router: '0x00000000005BBB0EF59571E58418F9a4357b68A0',
    marketFactory: '0xDcceA1FE2D3C8e7E3F2D5C9a91f5C0Fd7c1aF3Ba',
  },
  optimism: {
    router: '0x00000000005BBB0EF59571E58418F9a4357b68A0',
  },
};

const MARKET_ABI = parseAbi([
  'function readState(address router) external view returns (int256 totalPt, int256 totalSy, int256 totalLp, address treasury, int256 scalarRoot, uint256 expiry, uint256 lnFeeRateRoot, uint256 reserveFeePercent, uint256 lastLnImpliedRate)',
  'function isExpired() external view returns (bool)',
]);

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

// Pendle PT positions can be redeemed at expiry. After expiry, anyone can redeem
// undercollateralized positions in vaults like Penpie, Equilibria, etc.
export async function scanPendleExpiredMarkets(chain) {
  // For now, this is a placeholder for monitoring expired markets
  // Full implementation would need market list discovery via PendleAPI
  return [];
}

export function subscribePendleEvents(chain, wsClient, onOpportunity) {
  // Pendle markets emit events on swap/redeem
  // Watching expiry events helps catch unwound positions
  logger.info('Pendle subscription stub for ' + chain);
}
