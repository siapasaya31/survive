import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { logger } from '../lib/logger.js';

// Morpho Blue is on Base (mainnet too, but we focus L2)
export const MORPHO_BLUE = {
  base: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
};

const MORPHO_ABI = parseAbi([
  'function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function idToMarketParams(bytes32 id) external view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
]);

const SUPPLY_COLLATERAL_EVENT = [{
  type: 'event', name: 'SupplyCollateral',
  inputs: [
    { type: 'bytes32', indexed: true, name: 'id' },
    { type: 'address', indexed: true, name: 'caller' },
    { type: 'address', indexed: true, name: 'onBehalf' },
    { type: 'uint256', indexed: false, name: 'assets' },
  ],
}];

const BORROW_EVENT = [{
  type: 'event', name: 'Borrow',
  inputs: [
    { type: 'bytes32', indexed: true, name: 'id' },
    { type: 'address', indexed: false, name: 'caller' },
    { type: 'address', indexed: true, name: 'onBehalf' },
    { type: 'address', indexed: true, name: 'receiver' },
    { type: 'uint256', indexed: false, name: 'assets' },
    { type: 'uint256', indexed: false, name: 'shares' },
  ],
}];

function getRpc(chain) {
  return process.env[`RPC_${chain.toUpperCase()}`];
}

// Get all active markets by reading Borrow events
export async function getActiveMarkets(chain) {
  const morpho = MORPHO_BLUE[chain];
  if (!morpho) return [];

  const client = createPublicClient({ chain: base, transport: http(getRpc(chain)) });

  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest - 5000n;
    const logs = await client.getLogs({
      address: morpho,
      event: BORROW_EVENT[0],
      fromBlock, toBlock: latest,
    });

    return [...new Set(logs.map(l => l.args.id).filter(Boolean))];
  } catch (e) {
    logger.warn(`getActiveMarkets: ${e.message}`);
    return [];
  }
}

export async function getActiveBorrowers(chain, marketId) {
  const morpho = MORPHO_BLUE[chain];
  if (!morpho) return [];

  const client = createPublicClient({ chain: base, transport: http(getRpc(chain)) });
  try {
    const latest = await client.getBlockNumber();
    const fromBlock = latest - 5000n;
    const logs = await client.getLogs({
      address: morpho,
      event: BORROW_EVENT[0],
      args: { id: marketId },
      fromBlock, toBlock: latest,
    });
    return [...new Set(logs.map(l => l.args.onBehalf).filter(Boolean))];
  } catch (e) {
    logger.warn(`getActiveBorrowers: ${e.message}`);
    return [];
  }
}

export async function checkMorphoLiquidatable(chain, marketId, borrower) {
  const morpho = MORPHO_BLUE[chain];
  const client = createPublicClient({ chain: base, transport: http(getRpc(chain)) });

  try {
    const [position, marketParams, market] = await Promise.all([
      client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: 'position', args: [marketId, borrower] }),
      client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: 'idToMarketParams', args: [marketId] }),
      client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: 'market', args: [marketId] }),
    ]);

    const borrowShares = position[1];
    const collateral   = position[2];

    if (borrowShares === 0n) return null;
    if (collateral === 0n) return null;

    return {
      borrower,
      marketId,
      collateralAsset: marketParams[1],
      debtAsset:       marketParams[0],
      lltv:            marketParams[4],
      collateralAmount: collateral,
      borrowShares,
      marketParams: {
        loanToken:       marketParams[0],
        collateralToken: marketParams[1],
        oracle:          marketParams[2],
        irm:             marketParams[3],
        lltv:            marketParams[4],
      },
    };
  } catch (e) {
    return null;
  }
}

export function subscribeMorphoEvents(chain, wsClient, onUpdate) {
  const morpho = MORPHO_BLUE[chain];
  if (!morpho) return;

  // Watch Borrow → check if newly liquidatable
  wsClient.watchContractEvent({
    address: morpho,
    abi: BORROW_EVENT,
    eventName: 'Borrow',
    onLogs: async (logs) => {
      for (const log of logs) {
        const borrower = log.args.onBehalf;
        const marketId = log.args.id;
        if (!borrower || !marketId) continue;
        const result = await checkMorphoLiquidatable(chain, marketId, borrower);
        if (result) onUpdate(chain, result);
      }
    },
    onError: (e) => logger.warn(`Morpho borrow ${chain}: ${e.message}`),
  });
}
