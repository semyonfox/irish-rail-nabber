-- Track GraphQL request usage per identity per day for tier-based limits.
CREATE TABLE IF NOT EXISTS api_daily_usage (
    for_date DATE NOT NULL DEFAULT CURRENT_DATE,
    subject TEXT NOT NULL,
    request_count BIGINT NOT NULL DEFAULT 1,
    role_snapshot TEXT NOT NULL DEFAULT 'free',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (for_date, subject)
);

CREATE INDEX IF NOT EXISTS idx_api_daily_usage_for_date ON api_daily_usage (for_date);
