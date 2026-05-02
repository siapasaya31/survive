import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { getEthPrice } from '../lib/prices.js';
import { db } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

// When ETH price diverges between chains, posisi liquidatable di salah satu chain
// tapi belum di chain lain — opportunity sebelum oracle sync
export async function scanPriceDivergence() {
  try {
    const [basePrice, arbPrice, opPrice] = await Promise.all([
      getEthPrice('base'),
      getEthPrice('arbitrum'),
      getEthPrice('optimism'),
    ]);

    const prices = { base: basePrice, arbitrum: arbPrice, optimism: opPrice };
    const minPrice = Math.min(basePrice, arbPrice, opPrice);
    const maxPrice = Math.max(basePrice, arbPrice, opPrice);
    const divergencePct = (maxPrice - minPrice) / minPrice * 100;

    if (divergencePct > 0.05) {
      // Find which chain has lower price (= more liquidations)
      const lowerChain = Object.entries(prices).find(([_, p]) => p === minPrice)[0];
      logger.info(`price divergence ${divergencePct.toFixed(3)}%: lower=${lowerChain} ($${minPrice.toFixed(2)}), higher=$${maxPrice.toFixed(2)}`);
      return { divergencePct, lowerChain, prices };
    }
    return null;
  } catch (e) {
    logger.warn(`price divergence scan: ${e.message}`);
    return null;
  }
}
