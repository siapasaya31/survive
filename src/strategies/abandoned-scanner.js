import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { db } from '../lib/budget.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };

const ERC20_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
  'function owner() external view returns (address)',
  'function paused() external view returns (bool)',
]);

// Known post-exploit contract addresses with potentially stuck funds
// Updated manually as exploits are discovered
const KNOWN_POST_EXPLOIT = [
  // Format: { chain, address, protocol, exploitDate, estimatedStuck }
  // These are populated dynamically from postmortem scanner
];

// Patterns for detecting abandoned contracts:
// 1. Contract has ETH/token balance but no recent txs
// 2. Owner key is known (published accidentally)
// 3. Contract has emergency withdraw function
// 4. Contract is paused with funds inside

const WITHDRAW_CHECK_PROMPT = `You are analyzing a smart contract for stuck/recoverable funds.
Check if the contract has:
1. An emergency withdraw function callable by anyone
2. A sweep function
3. A rescue function
4. Any function that allows non-owner to withdraw
5. Known vulnerability that allows unauthorized withdrawal

Source code excerpt:
{SOURCE}

Output STRICT JSON:
{
  "has_recovery_path": <bool>,
  "recovery_function": "<function signature or null>",
  "requires_owner": <bool>,
  "confidence": <int 0-100>,
  "method": "<description of recovery path>"
}`;

export async function checkAbandonedContract(chain, address, source) {
  if (!source) return null;
  const prompt = WITHDRAW_CHECK_PROMPT.replace('{SOURCE}', source.slice(0, 6000));
  const r = await mimoChat({
    messages: [
      { role: 'system', content: 'You analyze smart contracts for fund recovery paths.' },
      { role: 'user', content: prompt },
    ],
    agent: 'exploit-hunter', purpose: 'abandoned-check', maxTokens: 400, pro: true,
  });
  return parseJSON(r.text);
}

// Monitor failed bridge transactions that can be retried
export async function scanFailedBridgeRetry(chain) {
  const client = createPublicClient({
    chain: CHAIN_DEF[chain],
    transport: http(process.env['RPC_' + chain.toUpperCase()]),
  });

  // Stargate Finance failed txs
  const STARGATE_ROUTER = {
    base:     '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
    arbitrum: '0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614',
    optimism: '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',
  };

  // Across Protocol stuck fills
  const ACROSS_SPOKE = {
    base:     '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
    arbitrum: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
    optimism: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
  };

  return [];
}

export async function runAbandonedScan() {
  logger.info('scanning for abandoned contracts with stuck funds...');
  const findings = [];

  // Check known post-exploit addresses
  for (const target of KNOWN_POST_EXPLOIT) {
    const client = createPublicClient({
      chain: CHAIN_DEF[target.chain],
      transport: http(process.env['RPC_' + target.chain.toUpperCase()]),
    });

    try {
      const ethBal = await client.getBalance({ address: target.address });
      if (ethBal < 10n ** 15n) continue; // < 0.001 ETH, skip

      logger.info('Found funds in post-exploit contract: ' + target.protocol + ' $' + (Number(ethBal) / 1e18 * 3500).toFixed(2));
      findings.push({ ...target, ethBalance: ethBal.toString() });
    } catch {}
  }

  return findings;
}
