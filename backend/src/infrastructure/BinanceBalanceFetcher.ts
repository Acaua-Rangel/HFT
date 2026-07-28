import { Amount } from "../domain/valueObjects/Amount";
import * as crypto from "crypto";

export class BinanceBalanceFetcher {
  private readonly key: string = process.env.BINANCE_API_KEY || "";
  private readonly secret: string = process.env.BINANCE_API_SECRET || "";

  public async fetchBrlBalance(): Promise<Amount> {
    const hasKeys = this.key.length > 0 && this.secret.length > 0;
    if (!hasKeys) {
      console.warn("⚠️ Binance API Keys missing. Cannot fetch real balance.");
      return new Amount(0);
    }

    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = crypto.createHmac("sha256", this.secret).update(queryString).digest("hex");
      const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

      const response = await fetch(url, {
        method: "GET",
        headers: { "X-MBX-APIKEY": this.key }
      });

      const isOk = response.ok === true;
      if (!isOk) {
        console.error(`❌ HTTP Error when fetching balance: ${response.status}`);
        return new Amount(0);
      }

      const data = await response.json();
      const brlBalance = data.balances.find((b: any) => b.asset === "BRL");
      
      const hasBalance = brlBalance !== undefined;
      if (hasBalance) {
        const freeAmount = parseFloat(brlBalance.free);
        return new Amount(freeAmount);
      }
      return new Amount(0);
    } catch (e) {
      console.error("❌ Failed to fetch balance from Binance API", e);
      return new Amount(0);
    }
  }
}
