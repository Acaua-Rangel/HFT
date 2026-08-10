import { Database } from "bun:sqlite";

console.log("=========================================");
console.log("🔎 HFT ENGINE DIAGNOSTIC SCRIPT 🔎");
console.log("=========================================\n");

try {
    const db = new Database("./hft.sqlite", { readonly: true });

    // 1. Check Last Transactions (Did it trade at all?)
    console.log("--- 🛒 LAST 5 TRANSACTIONS ---");
    const txs = db.query("SELECT * FROM transaction_logs ORDER BY timestamp DESC LIMIT 5").all();
    if (txs.length === 0) {
        console.log("❌ No transactions found in the database.");
    } else {
        for (const row of txs) {
            const date = new Date(row.timestamp).toISOString();
            console.log(`[${date}] ${row.symbol} ${row.side} | Qty: ${row.executed_qty} @ Price: ${row.average_price}`);
        }
        
        const lastTxTime = txs[0].timestamp;
        const msSinceLastTx = Date.now() - lastTxTime;
        console.log(`\n⏳ Time since last trade: ${(msSinceLastTx / 1000 / 60).toFixed(2)} minutes`);
    }

    // 2. Check Last Errors
    console.log("\n--- 🛑 LAST 10 ERRORS ---");
    const errors = db.query("SELECT * FROM error_logs ORDER BY timestamp DESC LIMIT 10").all();
    if (errors.length === 0) {
        console.log("✅ No errors found in the recent logs.");
    } else {
        let has2010 = false;
        let hasRateLimit = false;
        let hasWsDrop = false;
        for (const row of errors) {
            const date = new Date(row.timestamp).toISOString();
            console.log(`[${date}] ${row.error_type}: ${row.message}`);
            
            if (row.message.includes("-2010") || row.error_type.includes("INSUFFICIENT_FUNDS")) has2010 = true;
            if (row.error_type.includes("RATE_LIMIT")) hasRateLimit = true;
            if (row.message.includes("WebSocket") || row.error_type.includes("TIMEOUT")) hasWsDrop = true;
        }

        console.log("\n--- 🧠 ANALYSIS OF ERRORS ---");
        if (has2010) {
            console.log("⚠️ -2010 Insufficient Balance found! Suas ordens pendentes (hanging) podem estar travando todo o capital no lado da Binance, ou o bot tentou enviar uma ordem maior do que o saldo livre.");
        }
        if (hasRateLimit) {
            console.log("⚠️ Rate Limit exceeded! A Binance puniu o bot por enviar muitas requisições por segundo. O bot pode ter pausado as operações para evitar banimento.");
        }
        if (hasWsDrop) {
            console.log("⚠️ WebSocket Drops/Timeouts detectados. O motor pode ter perdido a conexão com o livro de ofertas da Binance ou com o UserDataStream, o que cega o robô e impede operações.");
        }
    }

    db.close();
} catch (e) {
    console.error("Failed to read SQLite database. Is the script in the same folder as hft.sqlite?", e);
}

console.log("\n=========================================");
console.log("Se não houver erros acima, o motivo de não operar pode ser:");
console.log("1. Spread muito apertado (Circuit Breaker barrou).");
console.log("2. Falta de saldo (Base ou Quote zerados).");
console.log("3. UserDataStream desconectado silenciosamente (ordens pendentes travando saldo).");
console.log("=========================================\n");
