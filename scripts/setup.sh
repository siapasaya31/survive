#!/bin/bash
set -euo pipefail

echo "=== Recon Agent VPS Setup (Ubuntu 22.04 ARM64) ==="

if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v)"

if ! command -v psql &> /dev/null; then
  echo "Installing PostgreSQL 15..."
  sudo apt-get install -y postgresql-15 postgresql-contrib-15
  sudo systemctl enable --now postgresql
fi

if ! command -v redis-cli &> /dev/null; then
  echo "Installing Redis..."
  sudo apt-get install -y redis-server
  sudo systemctl enable --now redis-server
fi

if ! command -v anvil &> /dev/null; then
  echo "Installing Foundry (ARM64)..."
  if [ ! -d "$HOME/.cargo" ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
  fi
  cargo install --git https://github.com/foundry-rs/foundry --profile release anvil cast forge
fi

if ! command -v pm2 &> /dev/null; then
  echo "Installing PM2..."
  sudo npm install -g pm2
fi

echo "Setting up Postgres database..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='recon'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE recon;"
sudo -u postgres psql -tc "SELECT 1 FROM pg_user WHERE usename='recon'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER recon WITH ENCRYPTED PASSWORD 'reconpass';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE recon TO recon;"
sudo -u postgres psql -d recon -c "GRANT ALL ON SCHEMA public TO recon;"

echo "Installing npm dependencies..."
cd "$(dirname "$0")/.."
npm install

echo "Loading database schema..."
PGPASSWORD=reconpass psql -h localhost -U recon -d recon -f sql/schema.sql

mkdir -p logs

if [ ! -f config/.env ]; then
  cp config/.env.example config/.env
  echo ""
  echo "⚠️  Edit config/.env with your API keys before starting!"
  echo "    Required: MIMO_API_KEY, ETH_PRIVATE_KEY, ALCHEMY_API_KEY,"
  echo "              TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY"
fi

chmod 600 config/.env 2>/dev/null || true

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. nano config/.env  # fill in API keys"
echo "  2. npm run status    # verify db connection"
echo "  3. pm2 start ecosystem.config.cjs"
echo "  4. pm2 logs"
