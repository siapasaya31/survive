import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { createPublicClient, http, parseAbi } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { db } from '../lib/budget.js';
import { logger } from '../lib/logger.js';

const CHAIN_DEF = { base, arbitrum, optimism };
const CHAINS = ['base', 'arbitrum', 'optimism'];

const SCAN_APIS = {
  base:     { api: 'https://api.basescan.org/api',    key: process.env.BASESCAN_API_KEY },
  arbitrum: { api: 'https://api.arbiscan.io/api',     key: process.env.ARBISCAN_API_KEY },
  optimism: { api: 'https://api.opscan.io/api',       key: process.env.OPSCAN_API_KEY },
  ethereum: { api: 'https://api.etherscan.io/api',    key: process.env.ETHERSCAN_API_KEY },
};

// Search for contracts similar to known vulnerable contracts
export async function findSimilarContracts(vulnPattern, chain) {
  // Use Etherscan/similar to search by contract code similarity
  // Strategy: search for known function signatures of vulnerable protocol
  const api = SCAN_APIS[chain];
  if (!api?.key) return [];

  try {
    // Get recently deployed contracts (last 30 days) matching pattern
    // Note: Etherscan doesn't support full-text search on source, so we
    // use DeFiLlama protocol list + match against known vulnerable codebases
    const res = await fetch(
      `https://api.llama.fi/protocols`,
      { signal: AbortSignal.timeout(10000) }
    );
    const protocols = await res.json();

    // Filter protocols on target chain with TVL > $10K (worth exploiting)
    return protocols
      .filter(p => p.chains?.includes(chain.charAt(0).toUpperCase() + chain.slice(1)))
      .filter(p => (p.tvl || 0) > 10000)
      .slice(0, 50)
      .map(p => ({ name: p.name, slug: p.slug, tvl: p.tvl, chain }));
  } catch (e) {
    logger.warn('findSimilarContracts: ' + e.message);
    return [];
  }
}

// Get contract source code from Etherscan
export async function getContractSource(chain, address) {
  const api = SCAN_APIS[chain];
  if (!api?.key) return null;
  try {
    const url = api.api + '?module=contract&action=getsourcecode&address=' + address + '&apikey=' + api.key;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.result?.[0]?.SourceCode) {
      return data.result[0].SourceCode;
    }
  } catch {}
  return null;
}

// Check if contract has funds (TVL via DefiLlama or direct balance check)
export async function checkContractBalance(chain, address, ethPriceUsd = 3500) {
  const client = createPublicClient({ chain: CHAIN_DEF[chain], transport: http(process.env['RPC_' + chain.toUpperCase()]) });
  try {
    const bal = await client.getBalance({ address });
    const ethBal = Number(bal) / 1e18;
    // Also check USDC/USDT balance
    const ERC20_ABI = parseAbi(['function balanceOf(address) external view returns (uint256)']);
    const USDC = { base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' };
    let usdcBal = 0;
    if (USDC[chain]) {
      const raw = await client.readContract({ address: USDC[chain], abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
      usdcBal = Number(raw) / 1e6;
    }
    return { ethBal, usdcBal, totalUsd: ethBal * ethPriceUsd + usdcBal };
  } catch { return { ethBal: 0, usdcBal: 0, totalUsd: 0 }; }
}

const VULN_CHECK_PROMPT = `You are an expert smart contract auditor.
Given source code and a known vulnerability pattern, determine if the contract is vulnerable.
Output STRICT JSON:
{
  "is_vulnerable": <bool>,
  "confidence": <int 0-100>,
  "affected_function": "<function name or null>",
  "exploit_path": "<brief description or null>",
  "recoverable_usd_estimate": <float or 0>
}`;

export async function checkVulnerability(sourceCode, vulnPattern) {
  if (!sourceCode || sourceCode.length < 100) return null;
  const truncated = sourceCode.slice(0, 8000); // fit in context
  const r = await mimoChat({
    messages: [
      { role: 'system', content: VULN_CHECK_PROMPT },
      { role: 'user', content: 'Vulnerability pattern: ' + vulnPattern + '\n\nSource code:\n' + truncated },
    ],
    agent: 'exploit-hunter', purpose: 'vuln-check', maxTokens: 400, pro: true,
  });
  return parseJSON(r.text);
}

export async function scanForkVulnerabilities(exploitAnalysis) {
  if (!exploitAnalysis?.similar_protocols?.length) return [];
  const findings = [];

  for (const chain of CHAINS) {
    const protocols = await findSimilarContracts(exploitAnalysis.vuln_type, chain);

    for (const protocol of protocols.slice(0, 20)) {
      // Get protocol contract address from DefiLlama
      try {
        const res = await fetch('https://api.llama.fi/protocol/' + protocol.slug, { signal: AbortSignal.timeout(8000) });
        const detail = await res.json();
        const addrs = detail.address ? [detail.address] : [];

        for (const addr of addrs.slice(0, 3)) {
          if (!addr || addr.length < 10) continue;

          // Check if contract has meaningful TVL
          const balance = await checkContractBalance(chain, addr);
          if (balance.totalUsd < 100) continue; // Skip dust

          // Get source code and check vulnerability
          const source = await getContractSource(chain, addr);
          const vuln = await checkVulnerability(source, exploitAnalysis.vuln_type);

          if (vuln?.is_vulnerable && vuln.confidence > 70) {
            logger.info('VULNERABLE FORK FOUND: ' + protocol.name + ' on ' + chain + ' ($' + balance.totalUsd.toFixed(0) + ')');
            findings.push({
              protocol: protocol.name,
              chain,
              address: addr,
              tvl: balance.totalUsd,
              vuln,
              exploitType: exploitAnalysis.vuln_type,
            });

            await db.query(`
              INSERT INTO exploit_findings (protocol, chain, address, tvl_usd, vuln_type, confidence, exploit_path, status, found_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,'found',NOW())
              ON CONFLICT DO NOTHING
            `, [protocol.name, chain, addr, balance.totalUsd, exploitAnalysis.vuln_type, vuln.confidence, vuln.exploit_path]).catch(() => {});
          }
        }
      } catch {}
    }
  }
  return findings;
}
