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

class FeeCache {
  private readonly cache: Map<string, Fee> = new Map();
  private readonly pending: Map<string, Promise<Fee>> = new Map();

  public get(symbol: string): Fee | undefined {
    return this.cache.get(symbol);
  }

  public set(symbol: string, fee: Fee): void {
    this.cache.set(symbol, fee);
    this.pending.delete(symbol);
  }

  public getPending(symbol: string): Promise<Fee> | undefined {
    return this.pending.get(symbol);
  }

  public setPending(symbol: string, promise: Promise<Fee>): void {
    this.pending.set(symbol, promise);
  }
}

export class BinanceFeeFetcher implements FeeFetcher {
  private readonly cache = new FeeCache();
  private readonly credentials = new ApiCredentials();
  private readonly defaultFee = new Fee(new Amount(0.001));

  public async fetchFeeFor(pair: Pair): Promise<Fee> {
    return new Promise((resolve) => {
      pair.applyBinanceStreamFormat(async (streamName) => {
        const symbol = streamName.replace("@bookTicker", "").toUpperCase();

        // 1. Check cache first
        const cached = this.cache.get(symbol);
        if (cached) {
          resolve(cached);
          return;
        }

        // 2. If no API keys, use default immediately (no HTTP call)
        if (!this.credentials.isConfigured()) {
          this.cache.set(symbol, this.defaultFee);
          resolve(this.defaultFee);
          return;
        }

        // 3. Check if a fetch is already in-flight for this symbol
        const pendingPromise = this.cache.getPending(symbol);
        if (pendingPromise) {
          const fee = await pendingPromise;
          resolve(fee);
          return;
        }

        // 4. Start a new fetch and register a safe promise
        const fetchPromise = this.performHttpRequest(symbol)
          .then((fee) => {
            this.cache.set(symbol, fee);
            return fee;
          })
          .catch(() => {
            console.warn(`⚠️ Fee fetch failed for ${symbol}, using 0.1% fallback.`);
            this.cache.set(symbol, this.defaultFee);
            return this.defaultFee;
          });

        this.cache.setPending(symbol, fetchPromise);
        const result = await fetchPromise;
        resolve(result);
      });
    });
  }

  private async performHttpRequest(symbol: string): Promise<Fee> {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = this.credentials.sign(queryString);
    const url = `https://api.binance.com/sapi/v1/asset/tradeFee?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.credentials.asHeaders(),
    });

    const isOk = response.ok === true;
    if (!isOk) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const data = await response.json();
    let makerFee = 0.001; // fallback default if array is empty
    if (Array.isArray(data) && data.length > 0) {
      makerFee = parseFloat(data[0].makerCommission);
    } else if (data.makerCommission) {
      makerFee = parseFloat(data.makerCommission);
    }
    return new Fee(new Amount(makerFee));
  }
}
