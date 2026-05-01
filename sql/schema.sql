CREATE TABLE IF NOT EXISTS budget_ledger (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resource TEXT NOT NULL CHECK (resource IN ('anthropic','mimo','eth_gas','rpc')),
    amount_usd NUMERIC(14,8) NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    chain TEXT,
    tx_hash TEXT,
    purpose TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON budget_ledger(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_resource_ts ON budget_ledger(resource, ts DESC);

CREATE TABLE IF NOT EXISTS opportunities (
    id BIGSERIAL PRIMARY KEY,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    strategy TEXT NOT NULL CHECK (strategy IN ('dex_arb','liquidation','bridge_recovery')),
    chain TEXT NOT NULL,
    block_number BIGINT,
    fingerprint TEXT UNIQUE,
    raw_data JSONB,
    triage_score INTEGER CHECK (triage_score BETWEEN 0 AND 100),
    expected_gross_profit_usd NUMERIC(14,6),
    expected_gas_cost_usd NUMERIC(14,6),
    expected_net_profit_usd NUMERIC(14,6),
    sim_result JSONB,
    status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN
        ('discovered','triaged','simulated','pending_approval','approved','executed','rejected','expired','failed')),
    approval_msg_id TEXT,
    decided_at TIMESTAMPTZ,
    decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_opp_strategy ON opportunities(strategy, status);

CREATE TABLE IF NOT EXISTS executions (
    id BIGSERIAL PRIMARY KEY,
    opportunity_id BIGINT REFERENCES opportunities(id),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    chain TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    tx_status TEXT CHECK (tx_status IN ('pending','success','reverted','dropped')),
    gas_used BIGINT,
    gas_price_gwei NUMERIC(14,4),
    gas_cost_usd NUMERIC(14,6),
    actual_profit_usd NUMERIC(14,6),
    confirmed_at TIMESTAMPTZ,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_opp ON executions(opportunity_id);

CREATE TABLE IF NOT EXISTS scanner_runs (
    id BIGSERIAL PRIMARY KEY,
    strategy TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    items_scanned INTEGER DEFAULT 0,
    items_triaged INTEGER DEFAULT 0,
    opportunities_created INTEGER DEFAULT 0,
    cost_usd NUMERIC(14,8) DEFAULT 0,
    error TEXT
);

CREATE OR REPLACE VIEW v_daily_status AS
SELECT
    DATE(ts) AS day,
    SUM(CASE WHEN resource='anthropic' THEN amount_usd ELSE 0 END) AS spent_anthropic,
    SUM(CASE WHEN resource='mimo' THEN amount_usd ELSE 0 END) AS spent_mimo,
    SUM(CASE WHEN resource='eth_gas' THEN amount_usd ELSE 0 END) AS spent_gas,
    (SELECT COALESCE(SUM(actual_profit_usd),0) FROM executions WHERE DATE(submitted_at)=DATE(ts) AND tx_status='success') AS revenue_usd,
    (SELECT COUNT(*) FROM executions WHERE DATE(submitted_at)=DATE(ts) AND tx_status='success') AS successful_tx,
    (SELECT COUNT(*) FROM executions WHERE DATE(submitted_at)=DATE(ts) AND tx_status='reverted') AS reverted_tx
FROM budget_ledger
GROUP BY DATE(ts)
ORDER BY day DESC;

CREATE OR REPLACE VIEW v_pending_approvals AS
SELECT id, strategy, chain, expected_net_profit_usd, discovered_at,
       NOW() - discovered_at AS waiting_for
FROM opportunities
WHERE status = 'pending_approval'
ORDER BY discovered_at;
