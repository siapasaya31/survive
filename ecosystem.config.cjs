module.exports = {
  apps: [
    {
      name: 'orchestrator',
      script: 'src/orchestrator.js',
      env_file: 'config/.env',
      max_memory_restart: '500M',
      restart_delay: 5000,
      max_restarts: 20,
      out_file: 'logs/orch.out',
      error_file: 'logs/orch.err',
    },
    {
      name: 'tg-listener',
      script: 'src/agents/telegram-listener.js',
      env_file: 'config/.env',
      max_memory_restart: '200M',
      restart_delay: 5000,
      out_file: 'logs/tg.out',
      error_file: 'logs/tg.err',
    },
  ],
};
