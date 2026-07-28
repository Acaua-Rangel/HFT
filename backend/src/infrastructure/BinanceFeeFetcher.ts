import type { FeeFetcher } from "../domain/interfaces/FeeFetcher";
import { Fee } from "../domain/valueObjects/Fee";
import { Amount } from "../domain/valueObjects/Amount";
import type { Pair } from "../domain/valueObjects/Pair";
import * as crypto from "crypto";

class ApiCredentials {
  constructor(
    private readonly key: string = process.env.BINANCE_API_KEY || "",
    private readonly secret: string = process.env.BINANCE_API_SECRET || ""
  ) {
    const hasKeys = this.key.length > 0 && this.secret.length > 0;
    if (!hasKeys) {
      console.warn("⚠️ Binance API Key/Secret missing. Fee fetching will fallback to default 0.1%.");
    }
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

  public getAndApply(symbol: string, callback: (fee: Fee) => void): boolean {
    const hasFee = this.cache.has(symbol);
    if (hasFee) {
      const fee = this.cache.get(symbol);
      callback(fee!);
      return true;
    }
    return false;
  }

  public set(symbol: string, fee: Fee): void {
    this.cache.set(symbol, fee);
  }
}

export class BinanceFeeFetcher implements FeeFetcher {
  private readonly cache = new FeeCache();
  private readonly credentials = new ApiCredentials();

  public async fetchFeeFor(pair: Pair): Promise<Fee> {
    return new Promise((resolve) => {
      pair.applyBinanceStreamFormat(async (streamName) => {
        const symbol = streamName.replace("@bookTicker", "").toUpperCase();
        
        const isCached = this.cache.getAndApply(symbol, (cachedFee) => {
          resolve(cachedFee);
        });

        if (isCached) {
          return;
        }

        this.executeApiFetch(symbol, resolve);
      });
    });
  }

  private async executeApiFetch(symbol: string, resolve: (fee: Fee) => void): Promise<void> {
    try {
      const fee = await this.performHttpRequest(symbol);
      this.cache.set(symbol, fee);
      resolve(fee);
    } catch (e) {
      console.error(`Error fetching fee for ${symbol}, fallback to 0.1%`);
      const fallbackFee = new Fee(new Amount(0.001));
      this.cache.set(symbol, fallbackFee);
      resolve(fallbackFee);
    }
  }

  private async performHttpRequest(symbol: string): Promise<Fee> {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
    const signature = this.credentials.sign(queryString);
    const url = `https://api.binance.com/api/v3/tradeFee?${queryString}&signature=${signature}`;

    const response = await fetch(url, {
      method: "GET",
      headers: this.credentials.asHeaders(),
    });

    const isOk = response.ok === true;
    if (!isOk) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const data = await response.json();
    const makerFee = parseFloat(data[0].makerCommission);
    return new Fee(new Amount(makerFee));
  }
}
