module.exports = {
  apps: [
    { name: 'orchestrator',   script: 'src/orchestrator.js',           cwd: '/home/arbbot/recon-agent', env_file: '/home/arbbot/recon-agent/config/.env', max_memory_restart: '500M', restart_delay: 5000, out_file: '/home/arbbot/recon-agent/logs/orch.out',    error_file: '/home/arbbot/recon-agent/logs/orch.err' },
    { name: 'tg-listener',    script: 'src/agents/telegram-listener.js', cwd: '/home/arbbot/recon-agent', env_file: '/home/arbbot/recon-agent/config/.env', max_memory_restart: '200M', restart_delay: 5000, out_file: '/home/arbbot/recon-agent/logs/tg.out',      error_file: '/home/arbbot/recon-agent/logs/tg.err' },
    { name: 'ws-monitor',     script: 'src/strategies/ws-monitor.js',  cwd: '/home/arbbot/recon-agent', env_file: '/home/arbbot/recon-agent/config/.env', max_memory_restart: '300M', restart_delay: 3000, out_file: '/home/arbbot/recon-agent/logs/ws.out',      error_file: '/home/arbbot/recon-agent/logs/ws.err' },
    { name: 'exploit-hunter', script: 'src/strategies/exploit-hunter.js', cwd: '/home/arbbot/recon-agent', env_file: '/home/arbbot/recon-agent/config/.env', max_memory_restart: '300M', restart_delay: 60000, out_file: '/home/arbbot/recon-agent/logs/exploit.out', error_file: '/home/arbbot/recon-agent/logs/exploit.err' },
    { name: 'v8-scanner',     script: 'src/strategies/v8-scanner.js',  cwd: '/home/arbbot/recon-agent', env_file: '/home/arbbot/recon-agent/config/.env', max_memory_restart: '300M', restart_delay: 30000, out_file: '/home/arbbot/recon-agent/logs/v8.out',      error_file: '/home/arbbot/recon-agent/logs/v8.err' },
  ],
};
