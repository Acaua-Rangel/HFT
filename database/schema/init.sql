CREATE TABLE IF NOT EXISTS transaction_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    trade_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    amount REAL NOT NULL,
    price REAL NOT NULL,
    profit REAL NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    error_type TEXT NOT NULL,
    message TEXT NOT NULL,
    stack_trace TEXT,
    context TEXT
);
