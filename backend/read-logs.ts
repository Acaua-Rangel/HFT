import { Database } from "bun:sqlite";

const db = new Database("./hft.sqlite");

console.log("=== LAST 20 ERRORS ===");
const errors = db.query("SELECT * FROM error_logs ORDER BY timestamp DESC LIMIT 20").all();
for (const row of errors) {
    const date = new Date(row.timestamp).toISOString();
    console.log(`[${date}] ${row.error_type}: ${row.message}`);
}

console.log("\n=== LAST 20 TRANSACTIONS ===");
const txs = db.query("SELECT * FROM transaction_logs ORDER BY timestamp DESC LIMIT 20").all();
for (const row of txs) {
    const date = new Date(row.timestamp).toISOString();
    console.log(`[${date}] ${row.symbol} ${row.side} | Qty: ${row.executed_qty} @ Price: ${row.average_price} (Fee: ${row.fee_amount})`);
}

db.close();
