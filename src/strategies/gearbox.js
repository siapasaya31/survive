import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { arbitrum, optimism } from 'viem/chains';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { arbitrum, optimism };

// Gearbox V3 Credit Managers
export const GEARBOX_CREDIT_MANAGERS = {
  arbitrum: [
    '0x5A952975B0d5dcBFb9571a7aE9e80B1F879fa4e5', // WETH credit manager
    '0x890A69EF363C9c7BdD5E36eb95Ceb569F63ACbF6', // USDC credit manager
  ],
  optimism: [],
};

const CREDIT_MANAGER_ABI = parseAbi([
  'function getCreditAccountsLen() external view returns (uint256)',
  'function creditAccounts(uint256 i) external view returns (address)',
  'function isLiquidatable(address creditAccount) external view returns (bool)',
  'function calcDebtAndCollateral(address creditAccount) external view returns (uint256 debt, uint256 cumulativeIndexLastUpdate, uint128 cumulativeQuotaInterest, uint256 accruedInterest, uint256 accruedFees, uint256 totalDebtUSD, uint256 totalValueUSD, uint16 twvUSD, uint16 enabledTokensMask, uint16 flags)',
]);

const ACCOUNT_OPENED_EVENT = [{
  type: 'event', name: 'OpenCreditAccount',
  inputs: [
    { type: 'address', indexed: true, name: 'onBehalfOf' },
    { type: 'address', indexed: true, name: 'creditAccount' },
    { type: 'address', indexed: false, name: 'manager' },
    { type: 'uint256', indexed: false, name: 'borrowAmount' },
    { type: 'uint16',  indexed: false, name: 'referralCode' },
  ],
}];

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

export async function checkGearboxLiquidatable(chain, creditManager, account) {
  const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
  try {
    const isLiq = await client.readContract({
      address: creditManager, abi: CREDIT_MANAGER_ABI,
      functionName: 'isLiquidatable', args: [account],
    });
    if (!isLiq) return null;

    const data = await client.readContract({
      address: creditManager, abi: CREDIT_MANAGER_ABI,
      functionName: 'calcDebtAndCollateral', args: [account],
    });
    return {
      borrower: account,
      creditManager,
      totalDebtUsd: Number(data[5]) / 1e8,
      totalValueUsd: Number(data[6]) / 1e8,
      protocol: 'gearbox',
    };
  } catch { return null; }
}

export async function scanGearboxAccounts(chain) {
  const managers = []; // disabled - wrong interface
  const liquidatable = [];

  for (const manager of managers) {
    const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
    try {
      const len = await client.readContract({
        address: manager, abi: CREDIT_MANAGER_ABI,
        functionName: 'getCreditAccountsLen',
      });
      const total = Number(len);
      // Sample first 50 accounts
      for (let i = 0; i < Math.min(total, 50); i++) {
        try {
          const acc = await client.readContract({
            address: manager, abi: CREDIT_MANAGER_ABI,
            functionName: 'creditAccounts', args: [BigInt(i)],
          });
          const result = await checkGearboxLiquidatable(chain, manager, acc);
          if (result) liquidatable.push(result);
        } catch {}
      }
    } catch (e) {
      logger.warn('Gearbox scan ' + chain + ': ' + e.message);
    }
  }
  return liquidatable;
}
