import type { FeeFetcher } from "../domain/interfaces/FeeFetcher";
import { Fee } from "../domain/valueObjects/Fee";
import { Amount } from "../domain/valueObjects/Amount";
import type { Pair } from "../domain/valueObjects/Pair";
import * as crypto from "crypto";

class ApiCredentials {
  private readonly hasKeys: boolean;

  constructor(
    private readonly key: string = (process.env.BINANCE_API_KEY || "").replace(/^["']|["']$/g, "").trim(),
    private readonly secret: string = (process.env.BINANCE_API_SECRET || "").replace(/^["']|["']$/g, "").trim()
  ) {
    this.hasKeys = this.key.length > 0 && this.secret.length > 0;
    if (!this.hasKeys) {
      console.warn("⚠️ Binance API Key/Secret missing. All fees will use default 0.1%.");
    }
  }

  public isConfigured(): boolean {
    return this.hasKeys;
  }

  public sign(queryString: string): string {
    return crypto.createHmac("sha256", this.secret).update(queryString).digest("hex");
  }

  public asHeaders(): Record<string, string> {
    return { "X-MBX-APIKEY": this.key };
  }
}

export class BinanceFeeFetcher implements FeeFetcher {
  private readonly cache = new Map<string, Fee>();
  private readonly credentials = new ApiCredentials();
  private readonly defaultFee = new Fee(new Amount(0.001));

  public async preloadFees(pairs: Pair[]): Promise<void> {
    if (!this.credentials.isConfigured()) {
      return;
    }

    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      const signature = this.credentials.sign(queryString);
      const url = `https://api.binance.com/sapi/v1/asset/tradeFee?${queryString}&signature=${signature}`;

      const response = await fetch(url, {
        method: "GET",
        headers: this.credentials.asHeaders(),
      });

      if (!response.ok) {
        console.warn(`⚠️ Bulk fee fetch failed: HTTP ${response.status}. Using default fees.`);
        return;
      }

      const data: any = await response.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.symbol && item.makerCommission) {
            const feeVal = parseFloat(item.makerCommission);
            this.cache.set(item.symbol.toUpperCase(), new Fee(new Amount(feeVal)));
          }
        }
      }
    } catch (e) {
      console.warn("⚠️ Error during bulk fee preload.", e);
    }
  }

  public getFeeFor(pair: Pair): Fee {
    let symbol = "";
    pair.applyBinanceSymbol((s) => { symbol = s; });

    const cached = this.cache.get(symbol);
    if (cached) {
      return cached;
    }

    // If not in cache, fallback to default immediately
    this.cache.set(symbol, this.defaultFee);
    
    // Background fetch for the specific missing pair (fire and forget)
    this.backgroundFetchFee(symbol);

    return this.defaultFee;
  }

  private backgroundFetchFee(symbol: string): void {
    if (!this.credentials.isConfigured()) return;

    (async () => {
      try {
        const timestamp = Date.now();
        const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
        const signature = this.credentials.sign(queryString);
        const url = `https://api.binance.com/sapi/v1/asset/tradeFee?${queryString}&signature=${signature}`;

        const response = await fetch(url, {
          method: "GET",
          headers: this.credentials.asHeaders(),
        });

        if (response.ok) {
          const data: any = await response.json();
          let makerFee = 0.001;
          if (Array.isArray(data) && data.length > 0) {
            makerFee = parseFloat(data[0].makerCommission);
          } else if (data.makerCommission) {
            makerFee = parseFloat(data.makerCommission);
          }
          this.cache.set(symbol, new Fee(new Amount(makerFee)));
        }
      } catch (e) {
        // Silent catch for background update
      }
    })();
  }
}
