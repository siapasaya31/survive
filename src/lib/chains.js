import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { base, arbitrum, optimism, mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from './logger.js';

const CHAIN_CONFIG = {
  base: { chain: base, rpc: process.env.RPC_BASE },
  arbitrum: { chain: arbitrum, rpc: process.env.RPC_ARBITRUM },
  optimism: { chain: optimism, rpc: process.env.RPC_OPTIMISM },
  ethereum: { chain: mainnet, rpc: process.env.RPC_ETHEREUM },
};

export const SUPPORTED_L2 = ['base', 'arbitrum', 'optimism'];

const publicClients = {};
const walletClients = {};

export function getPublicClient(chainName) {
  if (!publicClients[chainName]) {
    const cfg = CHAIN_CONFIG[chainName];
    if (!cfg) throw new Error(`Unsupported chain: ${chainName}`);
    publicClients[chainName] = createPublicClient({
      chain: cfg.chain,
      transport: http(cfg.rpc, { timeout: 15_000, retryCount: 2 }),
    });
  }
  return publicClients[chainName];
}

export function getWalletClient(chainName) {
  if (!walletClients[chainName]) {
    const pk = process.env.ETH_PRIVATE_KEY;
    if (!pk || !pk.startsWith('0x')) throw new Error('ETH_PRIVATE_KEY not set or malformed');
    const cfg = CHAIN_CONFIG[chainName];
    if (!cfg) throw new Error(`Unsupported chain: ${chainName}`);
    walletClients[chainName] = createWalletClient({
      account: privateKeyToAccount(pk),
      chain: cfg.chain,
      transport: http(cfg.rpc),
    });
  }
  return walletClients[chainName];
}

export async function getBalance(chainName, address = process.env.ETH_ADDRESS) {
  const client = getPublicClient(chainName);
  const wei = await client.getBalance({ address });
  return Number(wei) / 1e18;
}

export async function getGasPriceUsd(chainName, ethPriceUsd = 3500) {
  const client = getPublicClient(chainName);
  const gas = await client.getGasPrice();
  return { gasPrice: gas, ethPriceUsd };
}

export async function totalBalanceUsd(ethPriceUsd = 3500) {
  let total = 0;
  for (const ch of [...SUPPORTED_L2, 'ethereum']) {
    try {
      const eth = await getBalance(ch);
      total += eth * ethPriceUsd;
    } catch (e) {
      logger.warn(`Failed to get balance on ${ch}: ${e.message}`);
    }
  }
  return total;
}
