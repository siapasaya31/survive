import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { logger } from './logger.js';

const CHAINLINK_ABI = [{ inputs: [], name: 'latestRoundData', outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }], stateMutability: 'view', type: 'function' }];
const ETH_USD_FEED = { base: '0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70', arbitrum: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', optimism: '0x13e3Ee699D1909E989722E753853AE30b17e08c5' };
export const TOKEN_ADDRESSES = {
  base:     { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', WETH: '0x4200000000000000000000000000000000000006', cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452' },
  arbitrum: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', wstETH: '0x5979D7b546E38E414F7E9822514be443A4800529', DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' },
  optimism: { USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', WETH: '0x4200000000000000000000000000000000000006', wstETH: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' },
};
const CHAIN_DEF = { base, arbitrum, optimism };
const priceCache = {};
export function getTokenSymbol(chain, address) {
  for (const [sym, addr] of Object.entries(TOKEN_ADDRESSES[chain] || {})) {
    if (addr.toLowerCase() === address.toLowerCase()) return sym;
  }
  return null;
}
export function isStablecoin(sym) { return ['USDC','USDT','DAI','USDbC'].includes(sym); }
export function getPoolFee(col, debt) {
  if (isStablecoin(col) && isStablecoin(debt)) return 100;
  if (isStablecoin(col) || isStablecoin(debt)) return 500;
  return 3000;
}
export async function getEthPrice(chain = 'base') {
  const key = 'eth:' + chain;
  if (priceCache[key] && Date.now() - priceCache[key].ts < 30000) return priceCache[key].price;
  try {
    const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http() });
    const data = await client.readContract({ address: ETH_USD_FEED[chain], abi: CHAINLINK_ABI, functionName: 'latestRoundData' });
    const price = Number(data[1]) / 1e8;
    priceCache[key] = { price, ts: Date.now() };
    return price;
  } catch {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
      return (await res.json()).ethereum.usd;
    } catch { return 3500; }
  }
}
