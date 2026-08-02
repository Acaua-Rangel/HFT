import * as crypto from "crypto";

async function run() {
  const apiKey = (process.env.BINANCE_API_KEY || "").replace(/^["']|["']$/g, "").trim();
  const apiSecret = (process.env.BINANCE_API_SECRET || "").replace(/^["']|["']$/g, "").trim();

  if (!apiKey || !apiSecret) {
    console.log("No API keys found in .env");
    process.exit(1);
  }

  const symbols = [
    "BTCBRL", "ETHBTC", "ETHBRL",
    "USDTBRL", "PEPEUSDT", "PEPEBRL",
    "SHIBUSDT", "SHIBBRL",
    "DOGEUSDT", "DOGEBRL"
  ];

  // Look back 2 hours
  const startTime = Date.now() - (2 * 60 * 60 * 1000);
  
  let allTrades: any[] = [];

  for (const symbol of symbols) {
    const queryString = `symbol=${symbol}&startTime=${startTime}&timestamp=${Date.now()}`;
    const signature = crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");
    const url = `https://api.binance.com/api/v3/myTrades?${queryString}&signature=${signature}`;

    try {
      const res = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
      if (res.ok) {
        const trades = await res.json();
        allTrades = allTrades.concat(trades);
      }
    } catch (err) {}
  }

  // Sort by time
  allTrades.sort((a, b) => a.time - b.time);

  console.log(`Found ${allTrades.length} trades in the last 2 hours.`);
  if (allTrades.length === 0) {
      console.log("No trades found. Ensure the AWS bot traded recently.");
      return;
  }

  let totalCommissionBnb = 0;
  let totalCommissionBrl = 0;
  let totalCommissionOther = 0;

  for (const trade of allTrades) {
    const time = new Date(trade.time).toISOString();
    const side = trade.isBuyer ? "BUY" : "SELL";
    console.log(`[${time}] ${trade.symbol} | ${side} | Qty: ${trade.qty} @ Price: ${trade.price} | Fee: ${trade.commission} ${trade.commissionAsset}`);
    
    if (trade.commissionAsset === "BNB") {
        totalCommissionBnb += parseFloat(trade.commission);
    } else if (trade.commissionAsset === "BRL") {
        totalCommissionBrl += parseFloat(trade.commission);
    } else {
        totalCommissionOther += parseFloat(trade.commission); // Base asset fee
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Total Fees Paid in BNB: ${totalCommissionBnb}`);
  console.log(`Total Fees Paid in BRL: ${totalCommissionBrl}`);
  console.log(`Total Fees Paid in other Assets: ${totalCommissionOther}`);
}

run();
