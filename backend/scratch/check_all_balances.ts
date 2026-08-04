import * as crypto from "crypto";

async function run() {
  const apiKey = (process.env.BINANCE_API_KEY || "").replace(/^["']|["']$/g, "").trim();
  const apiSecret = (process.env.BINANCE_API_SECRET || "").replace(/^["']|["']$/g, "").trim();

  if (!apiKey || !apiSecret) {
    console.log("No API keys found in .env");
    process.exit(1);
  }

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");
  const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

  try {
    const res = await fetch(url, {
      headers: { "X-MBX-APIKEY": apiKey }
    });
    
    if (res.ok) {
      const data: any = await res.json();
      console.log("=== BINANCE SPOT BALANCES ===");
      for (const b of data.balances) {
        if (parseFloat(b.free) > 0 || parseFloat(b.locked) > 0) {
          console.log(`${b.asset}: Free = ${b.free} | Locked = ${b.locked}`);
        }
      }
    } else {
      console.log(`HTTP Error: ${res.status}`);
      console.log(await res.text());
    }
  } catch (err) {
    console.error("Error:", err);
  }
}

run();
