import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

const CHAINLINK_ABI = parseAbi([
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

// Critical price feeds to monitor for staleness
const PRICE_FEEDS = {
  base: [
    { name: 'ETH/USD',  addr: '0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70', heartbeat: 1200 },
    { name: 'BTC/USD',  addr: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F', heartbeat: 1200 },
    { name: 'cbETH/ETH',addr: '0x806b4Ac04501c29769051e42783cF04dCE41440b', heartbeat: 86400 },
  ],
  arbitrum: [
    { name: 'ETH/USD',  addr: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', heartbeat: 86400 },
    { name: 'BTC/USD',  addr: '0x6ce185860a4963106506C203335A2910413708e9', heartbeat: 86400 },
    { name: 'wstETH/ETH', addr: '0xb523AE262D20A936BC152e6023996e46FDC2A95D', heartbeat: 86400 },
  ],
  optimism: [
    { name: 'ETH/USD',  addr: '0x13e3Ee699D1909E989722E753853AE30b17e08c5', heartbeat: 1200 },
    { name: 'BTC/USD',  addr: '0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593', heartbeat: 1200 },
  ],
};

function getRpc(chain) { return process.env['RPC_' + chain.toUpperCase()]; }

// Check if oracle is stale (last update > heartbeat × 1.2)
export async function checkStaleOracles(chain) {
  const feeds = PRICE_FEEDS[chain] || [];
  const stale = [];

  for (const feed of feeds) {
    const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
    try {
      const data = await client.readContract({
        address: feed.addr, abi: CHAINLINK_ABI,
        functionName: 'latestRoundData',
      });
      const updatedAt = Number(data[3]);
      const ageSeconds = Math.floor(Date.now() / 1000) - updatedAt;

      if (ageSeconds > feed.heartbeat * 1.2) {
        stale.push({
          chain, feed: feed.name, address: feed.addr,
          ageSeconds, heartbeat: feed.heartbeat,
          stalenessRatio: (ageSeconds / feed.heartbeat).toFixed(2),
        });
      }
    } catch {}
  }
  return stale;
}

// Compare CEX price to oracle price to detect divergence
export async function checkOracleDivergence(chain) {
  const feeds = PRICE_FEEDS[chain] || [];
  const divergences = [];

  let cexPrice;
  try {
    const res = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=ETH');
    const data = await res.json();
    cexPrice = parseFloat(data.data.rates.USD);
  } catch { return []; }

  if (!cexPrice) return [];

  for (const feed of feeds) {
    if (!feed.name.includes('ETH/USD')) continue;
    const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(getRpc(chain)) });
    try {
      const data = await client.readContract({
        address: feed.addr, abi: CHAINLINK_ABI,
        functionName: 'latestRoundData',
      });
      const oraclePrice = Number(data[1]) / 1e8;
      const divergencePct = Math.abs(oraclePrice - cexPrice) / cexPrice * 100;

      if (divergencePct > 0.5) {
        divergences.push({
          chain, feed: feed.name,
          oraclePrice, cexPrice, divergencePct,
        });
      }
    } catch {}
  }
  return divergences;
}
