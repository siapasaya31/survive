import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { arbitrum } from 'viem/chains';
import { logger } from '../lib/logger.js';

export const NOTIONAL_V3 = {
  arbitrum: '0x1344A36A1B56144C3Bc62E7757377D288fDE0369',
};

const NOTIONAL_ABI = parseAbi([
  'function getAccountContext(address account) external view returns (uint40 nextSettleTime, bytes1 hasDebt, uint8 assetArrayLength, uint16 bitmapCurrencyId, bytes18 activeCurrencies)',
  'function calculateLocalCollateralAvailable(address account, uint16 currencyId) external view returns (int256 localAssetAvailable, int256 nTokenAssetAvailable)',
]);

const ACCOUNT_SETTLED_EVENT = [{
  type: 'event', name: 'AccountSettled',
  inputs: [{ type: 'address', indexed: true, name: 'account' }],
}];

function getRpc() { return process.env.RPC_ARBITRUM; }

export async function checkNotionalLiquidatable(account) {
  const client = createPublicClient({ chain: arbitrum, transport: http(getRpc()) });
  try {
    const ctx = await client.readContract({
      address: NOTIONAL_V3.arbitrum, abi: NOTIONAL_ABI,
      functionName: 'getAccountContext', args: [account],
    });
    const hasDebt = ctx[1];
    if (hasDebt === '0x00') return null;

    // Check collateral for major currencies (1=ETH, 2=DAI, 3=USDC, 4=WBTC)
    for (const cid of [1, 2, 3, 4]) {
      try {
        const coll = await client.readContract({
          address: NOTIONAL_V3.arbitrum, abi: NOTIONAL_ABI,
          functionName: 'calculateLocalCollateralAvailable', args: [account, cid],
        });
        const available = Number(coll[0]);
        if (available < 0) {
          return {
            borrower: account,
            currencyId: cid,
            shortfall: Math.abs(available),
            protocol: 'notional',
          };
        }
      } catch {}
    }
    return null;
  } catch { return null; }
}
