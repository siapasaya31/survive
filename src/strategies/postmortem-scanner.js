import dotenv from 'dotenv';
dotenv.config({path: '/home/arbbot/recon-agent/config/.env'});
import { db } from '../lib/budget.js';
import { mimoChat, parseJSON } from '../lib/llm.js';
import { logger } from '../lib/logger.js';

// Post-mortem and exploit alert sources
const SOURCES = [
  { name: 'rekt_news',     url: 'https://rekt.news/feed/',                   type: 'rss' },
  { name: 'blocksec',      url: 'https://blocksec.com/feed',                  type: 'rss' },
  { name: 'defihacklabs',  url: 'https://raw.githubusercontent.com/SunWeb3Sec/DeFiHackLabs/main/README.md', type: 'github' },
  { name: 'peckshield',    url: 'https://peckshield.com/rss.xml',             type: 'rss' },
  { name: 'certik_alerts', url: 'https://www.certik.com/resources/blog/feed', type: 'rss' },
];

// Etherscan-verified contract source API
const SOURCIFY_API = 'https://sourcify.dev/server';
const ETHERSCAN_API = 'https://api.etherscan.io/api';
const BASESCAN_API  = 'https://api.basescan.org/api';
const ARBISCAN_API  = 'https://api.arbiscan.io/api';

async function fetchRSS(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    // Parse RSS items
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(text)) !== null) {
      const titleMatch = m[1].match(/<title>(.*?)<\/title>/s);
      const descMatch = m[1].match(/<description>(.*?)<\/description>/s);
      const linkMatch = m[1].match(/<link>(.*?)<\/link>/s);
      const dateMatch = m[1].match(/<pubDate>(.*?)<\/pubDate>/s);
      if (titleMatch) {
        items.push({
          title: titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          description: (descMatch?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim().slice(0, 500),
          link: linkMatch?.[1]?.trim() || '',
          date: dateMatch?.[1]?.trim() || new Date().toISOString(),
        });
      }
    }
    return items;
  } catch (e) {
    logger.warn('RSS fetch ' + url + ': ' + e.message);
    return [];
  }
}

async function fetchDeFiHackLabs() {
  try {
    const res = await fetch(SOURCES[2].url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    // Extract table rows with hack info (date, protocol, amount)
    const rows = [];
    const rowRegex = /\|\s*(\d{4}\.\d{2}\.\d{2})\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g;
    let m;
    while ((m = rowRegex.exec(text)) !== null) {
      rows.push({ date: m[1], protocol: m[2].trim(), amount: m[3].trim() });
    }
    return rows.slice(0, 20); // Latest 20 hacks
  } catch (e) {
    logger.warn('DeFiHackLabs: ' + e.message);
    return [];
  }
}

const EXPLOIT_ANALYSIS_PROMPT = `You are a DeFi security researcher analyzing exploit post-mortems.
Given an exploit description, extract:
1. Vulnerable pattern (reentrancy, oracle manip, access control, etc.)
2. Affected contract signatures/functions
3. Whether funds remain recoverable (stuck in contract, whitehat possible)
4. List of similar protocols that might have same vulnerability

Output STRICT JSON:
{
  "vuln_type": "<type>",
  "affected_functions": ["func1", "func2"],
  "recoverable_funds": <bool>,
  "recovery_method": "<description or null>",
  "similar_protocols": ["protocol1", "protocol2"],
  "severity": "<critical|high|medium|low>",
  "confidence": <int 0-100>
}`;

export async function analyzeExploit(title, description) {
  const r = await mimoChat({
    messages: [
      { role: 'system', content: EXPLOIT_ANALYSIS_PROMPT },
      { role: 'user', content: 'Title: ' + title + '\n\nDescription: ' + description },
    ],
    agent: 'exploit-hunter', purpose: 'analyze', maxTokens: 600, pro: true,
  });
  return parseJSON(r.text);
}

export async function scanPostMortems() {
  const results = [];

  // Fetch all RSS sources
  for (const source of SOURCES.filter(s => s.type === 'rss')) {
    const items = await fetchRSS(source.url);
    for (const item of items.slice(0, 5)) {
      // Check if already analyzed
      const exists = await db.query(
        'SELECT id FROM exploit_leads WHERE source_url=$1',
        [item.link]
      ).catch(() => ({ rows: [] }));
      if (exists.rows.length > 0) continue;

      logger.info('new exploit post: ' + item.title);
      const analysis = await analyzeExploit(item.title, item.description);
      if (!analysis || analysis.confidence < 60) continue;

      results.push({ source: source.name, ...item, analysis });

      // Save to DB
      await db.query(`
        INSERT INTO exploit_leads (source, title, url, analysis, status, discovered_at)
        VALUES ($1,$2,$3,$4,'new',NOW())
        ON CONFLICT (url) DO NOTHING
      `, [source.name, item.title, item.link, JSON.stringify(analysis)]).catch(() => {});
    }
  }

  return results;
}
