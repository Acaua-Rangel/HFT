import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:3000");

ws.on("open", () => {
    console.log("Connected to HFT Engine WebSocket");
    ws.send(JSON.stringify({ type: "GET_STATUS" }));
});

ws.on("message", (data) => {
    try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "STATUS") {
            console.log("\n=== STATUS ===");
            console.log(`Mode: ${msg.mode}`);
            console.log(`Running: ${msg.isRunning}`);
            console.log(`Base Balance: ${msg.baseBalance}`);
            console.log(`Quote Balance: ${msg.quoteBalance}`);
            console.log(`Lot Mode: ${msg.lotMode} | Lot Value: ${msg.lotValue}`);
        } else if (msg.type === "TELEMETRY") {
            console.log("\n=== TELEMETRY ===");
            console.log(`Mid Price: ${msg.midPrice}`);
            console.log(`Bid Enabled: ${msg.bids.length > 0} | Ask Enabled: ${msg.asks.length > 0}`);
            console.log(`Inventory Skew (q): ${(msg.q * 100).toFixed(2)}%`);
            
            const totalWealth = (msg.baseBalance * msg.midPrice) + msg.quoteBalance;
            const baseLotQuote = msg.lotMode === "PERCENTAGE" ? totalWealth * msg.lotValue : msg.lotValue;
            console.log(`Total Wealth: ${totalWealth}`);
            console.log(`Base Lot Quote: ${baseLotQuote}`);
            
            console.log(`Effective Buy Lot (Quote): ${msg.effectiveBuyLot}`);
            console.log(`Effective Sell Lot (Quote): ${msg.effectiveSellLot}`);
            
            const minOrderValue = 10;
            console.log(`Meets MIN_ORDER_VALUE (Buy)? ${msg.effectiveBuyLot >= minOrderValue ? 'YES' : 'NO'}`);
            console.log(`Meets MIN_ORDER_VALUE (Sell)? ${msg.effectiveSellLot >= minOrderValue ? 'YES' : 'NO'}`);
            
            console.log(`\nHas enough QUOTE balance for 1st level?`);
            console.log(`Required: ${msg.effectiveBuyLot} | Available (Total): ${msg.quoteBalance}`);
            if (msg.effectiveBuyLot > msg.quoteBalance) {
                console.log("-> ❌ NOT ENOUGH QUOTE BALANCE");
            } else {
                console.log("-> ✅ ENOUGH QUOTE BALANCE (ignoring local locks)");
            }

            console.log(`\nHas enough BASE balance for 1st level?`);
            const sellLevelBase = msg.effectiveSellLot / msg.midPrice;
            console.log(`Required: ${sellLevelBase} BTC | Available (Total): ${msg.baseBalance} BTC`);
            if (sellLevelBase > msg.baseBalance) {
                console.log("-> ❌ NOT ENOUGH BASE BALANCE");
            } else {
                console.log("-> ✅ ENOUGH BASE BALANCE (ignoring local locks)");
            }
            
            process.exit(0);
        }
    } catch (e) {
        console.error("Error parsing message", e);
    }
});

ws.on("error", (error) => {
    console.error("WebSocket Error:", error);
});

setTimeout(() => {
    console.log("Timeout waiting for telemetry");
    process.exit(1);
}, 5000);
