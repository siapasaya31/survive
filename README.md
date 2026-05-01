# Recon Agent

DeFi opportunity scanner for L2 chains (Base, Arbitrum, Optimism). Monitors DEX arbitrage and Aave liquidations. Triages with MIMO, simulates with Anvil, requires Telegram approval before any onchain execution.

**Deadline: 28 May 2026**

## What this does

- Scans Uniswap V3 vs Aerodrome on Base for arbitrage spreads
- Monitors Aave V3 borrowers on Base/Arbitrum/Optimism for liquidatable positions
- Triages each candidate with MIMO v2.5 (~$0.0002 per candidate)
- Simulates the tx on a forked chain (Anvil) before broadcasting
- Sends Telegram notification: you approve `/approve_<id>` or reject `/reject_<id>`
- Hard limits: $0.30/day Anthropic, $2/day gas burn, $5 emergency stop-loss

## What this does NOT do

- No autonomous execution. Every tx requires your `/approve_<id>` reply.
- No mainnet trading. L2 only.
- No memecoin sniping, sandwich attacks, or front-running.
- No sub-$2 net profit opportunities (gas would eat them).

## Setup on Netcup ARM VPS

```bash
git clone <your-repo> ~/recon-agent
cd ~/recon-agent
bash scripts/setup.sh
```

The setup script installs Node 20, Postgres 15, Redis, Foundry (anvil/cast/forge), PM2, and creates the database.

## Configuration

Edit `config/.env` with:

| Variable | Where to get |
|---|---|
| `MIMO_API_KEY` | Your Xiaomi MIMO API key |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `ETH_PRIVATE_KEY` | A NEW hot wallet, fund with $5 ETH per L2 |
| `ETH_ADDRESS` | The address corresponding to above key |
| `ALCHEMY_API_KEY` | dashboard.alchemy.com (free tier OK) |
| `TELEGRAM_BOT_TOKEN` | Talk to @BotFather |
| `TELEGRAM_CHAT_ID` | Send a message to your bot, then GET https://api.telegram.org/bot<TOKEN>/getUpdates |
| `ETHERSCAN_API_KEY` | etherscan.io (free) |

`chmod 600 config/.env` after filling in.

## Wallet funding strategy

Total budget: $20 ETH.
Suggested split:
- $5 ETH on Base
- $5 ETH on Arbitrum
- $5 ETH on Optimism
- $5 ETH reserve on mainnet (use for emergency only)

## Running

```bash
pm2 start ecosystem.config.cjs
pm2 logs orchestrator
pm2 logs tg-listener
```

## Telegram commands

- `/status` — current survival report
- `/approve_<id>` — approve a pending opportunity
- `/reject_<id>` — reject one
- `/halt` — emergency: reject ALL pending opportunities

## Realistic expectations

This bot is **not a guaranteed survival mechanism**. With $20 modal in DeFi:
- 50% chance of ending below break-even after 27 days
- 30% chance of small profit ($10-50 net)
- 15% chance of meaningful profit ($50-200 net)
- 5% chance of larger profit ($200+ net)

Use this in parallel with off-chain income sources.

## Daily checks

```bash
npm run status
```

If after 7 days net is still negative, reconsider strategy. Consider increasing `MIN_NET_PROFIT_USD` or pausing.

## Emergency stop

If anything goes wrong:
```bash
pm2 stop all
```

In Telegram: `/halt`
