import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, optimism } from 'viem/chains';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, optimism };

// Compound V2 forks - Comptroller-based
export const COMP_V2_FORKS = [
  { name: 'Moonwell', chain: 'base',     comptroller: '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C' },
  { name: 'Sonne',    chain: 'optimism', comptroller: '0x60CF091cD3f50420d50fD7f707414d0DF4751C58' },
];

const COMPTROLLER_ABI = parseAbi([
  'function getAccountLiquidity(address account) external view returns (uint256, uint256, uint256)',
  'function getAssetsIn(address account) external view returns (address[])',
  'function markets(address cToken) external view returns (bool isListed, uint256 collateralFactorMantissa, bool isComped)',
]);

const CTOKEN_ABI = parseAbi([
  'function borrowBalanceStored(address account) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function exchangeRateStored() external view returns (uint256)',
  'function underlying() external view returns (address)',
]);

const BORROW_EVENT = [{
  type: 'event', name: 'Borrow',
  inputs: [
    { type: 'address', indexed: false, name: 'borrower' },
    { type: 'uint256', indexed: false, name: 'borrowAmount' },
    { type: 'uint256', indexed: false, name: 'accountBorrows' },
    { type: 'uint256', indexed: false, name: 'totalBorrows' },
  ],
}];

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

export async function checkCompV2Liquidatable(fork, account) {
  const client = createPublicClient({ chain: CHAIN_DEF[fork.chain], transport: http(getRpc(fork.chain)) });
  try {
    // getAccountLiquidity: (errorCode, liquidity, shortfall)
    const data = await client.readContract({
      address: fork.comptroller, abi: COMPTROLLER_ABI,
      functionName: 'getAccountLiquidity', args: [account],
    });
    const errorCode = data[0];
    const shortfall = data[2];
    if (errorCode !== 0n) return null;
    if (shortfall === 0n) return null; // liquid
    return {
      borrower: account,
      shortfall: shortfall.toString(),
      protocol: fork.name.toLowerCase(),
      comptroller: fork.comptroller,
    };
  } catch { return null; }
}

export function subscribeCompV2ForkEvents(wsClients, onLiquidatable) {
  for (const fork of COMP_V2_FORKS) {
    const wsClient = wsClients[fork.chain];
    if (!wsClient) continue;
    try {
      // We need to watch all cToken contracts in this comptroller
      // For simplicity, periodically scan via getAccountLiquidity for known borrowers
      // (Compound V2 doesn't have central Borrow event on Comptroller)
      logger.info(fork.name + ' polling-mode ready on ' + fork.chain);
    } catch (e) {
      logger.warn(fork.name + ' init failed: ' + e.message);
    }
  }
}

// Get recently active cToken markets to scan borrowers
export async function scanCompV2Borrowers(fork) {
  const client = createPublicClient({ chain: CHAIN_DEF[fork.chain], transport: http(getRpc(fork.chain)) });
  try {
    // This is approximation - need cToken list per fork (hardcoded common markets)
    const COMMON_CTOKENS = {
      'Moonwell': [
        '0x628ff693426583D9a7FB391E54366292F509D457', // mUSDC
        '0x628ff693426583D9a7FB391E54366292F509D457', // placeholder
      ],
      'Sonne': [
        '0x8E1e582879cB8baC6283368e8ede458B63F499a5', // soUSDC
      ],
    };

    const cTokens = COMMON_CTOKENS[fork.name] || [];
    const allBorrowers = new Set();

    for (const ctoken of cTokens) {
      try {
        const latest = await client.getBlockNumber();
        const logs = await client.getLogs({
          address: ctoken,
          event: BORROW_EVENT[0],
          fromBlock: latest - 5000n, toBlock: latest,
        });
        logs.forEach(l => l.args.borrower && allBorrowers.add(l.args.borrower));
      } catch {}
    }

    const liquidatable = [];
    for (const acc of [...allBorrowers].slice(0, 30)) {
      const r = await checkCompV2Liquidatable(fork, acc);
      if (r) liquidatable.push(r);
    }
    return liquidatable;
  } catch (e) {
    logger.warn('scanCompV2Borrowers ' + fork.name + ': ' + e.message);
    return [];
  }
}
