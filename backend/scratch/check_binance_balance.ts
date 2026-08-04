import * as crypto from "crypto";

async function run() {
  const apiKey = (process.env.BINANCE_API_KEY || "").replace(/^["']|["']$/g, "").trim();
  const apiSecret = (process.env.BINANCE_API_SECRET || "").replace(/^["']|["']$/g, "").trim();

  if (!apiKey || !apiSecret) {
    console.error("API Keys missing in .env");
    return;
  }

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");
  const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

  try {
    const response = await fetch(url, {
      headers: {
        "X-MBX-APIKEY": apiKey
      }
    });

    if (!response.ok) {
      console.error(`HTTP Error: ${response.status} ${response.statusText}`);
      const text = await response.text();
      console.error(text);
      return;
    }

    const data: any = await response.json();
    console.log("=== BINANCE SPOT BALANCES ===");
    const activeBalances = data.balances.filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
    
    activeBalances.forEach((b: any) => {
      console.log(`${b.asset}: Free = ${b.free} | Locked = ${b.locked}`);
    });
    
  } catch (err) {
    console.error("Failed to fetch:", err);
  }
}

run();
