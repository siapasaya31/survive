import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from './logger.js';

const execAsync = promisify(exec);

const CHAIN_RPC = {
  base: process.env.RPC_BASE,
  arbitrum: process.env.RPC_ARBITRUM,
  optimism: process.env.RPC_OPTIMISM,
  ethereum: process.env.RPC_ETHEREUM,
};

export async function runSimulation({ chain, txCalls, fromAddress }) {
  const rpcUrl = CHAIN_RPC[chain];
  if (!rpcUrl) throw new Error(`No RPC configured for ${chain}`);

  const port = 8545 + Math.floor(Math.random() * 1000);
  const anvilArgs = [
    '--fork-url', rpcUrl,
    '--port', port.toString(),
    '--silent',
    '--accounts', '1',
    '--balance', '100',
  ];

  logger.debug(`Starting anvil on port ${port} forking ${chain}`);
  const anvilProc = spawn('anvil', anvilArgs, { stdio: 'pipe' });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('anvil startup timeout')), 10000);
    let buffer = '';
    anvilProc.stdout.on('data', (data) => {
      buffer += data.toString();
      if (buffer.includes('Listening on') || buffer.includes(`port ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    anvilProc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  const forkRpc = `http://127.0.0.1:${port}`;

  try {
    const result = await simulateTxs(forkRpc, txCalls, fromAddress);
    return result;
  } finally {
    anvilProc.kill('SIGKILL');
  }
}

async function simulateTxs(rpcUrl, txCalls, fromAddress) {
  const client = createPublicClient({ transport: http(rpcUrl) });

  const balanceBefore = await client.getBalance({ address: fromAddress });
  const results = [];
  let totalGasUsed = 0n;
  let success = true;

  for (const call of txCalls) {
    try {
      const txHash = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction',
          params: [{ from: fromAddress, ...call }],
        }),
      }).then(r => r.json());

      if (txHash.error) {
        success = false;
        results.push({ ok: false, error: txHash.error.message });
        break;
      }

      const receipt = await client.waitForTransactionReceipt({ hash: txHash.result });
      totalGasUsed += receipt.gasUsed;
      if (receipt.status !== 'success') {
        success = false;
        results.push({ ok: false, error: 'reverted', hash: txHash.result });
        break;
      }
      results.push({ ok: true, hash: txHash.result, gasUsed: receipt.gasUsed.toString() });
    } catch (e) {
      success = false;
      results.push({ ok: false, error: e.message });
      break;
    }
  }

  const balanceAfter = await client.getBalance({ address: fromAddress });
  const profitWei = balanceAfter - balanceBefore;

  return {
    success,
    profitWei: profitWei.toString(),
    profitEth: Number(profitWei) / 1e18,
    totalGasUsed: totalGasUsed.toString(),
    txResults: results,
  };
}

export async function checkAnvilInstalled() {
  try {
    await execAsync('anvil --version');
    return true;
  } catch {
    return false;
  }
}
