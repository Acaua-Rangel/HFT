export class BinancePrecisionFetcher {
  private quantityPrecisionCache = new Map<string, number>();
  private priceTickSizeCache = new Map<string, number>();
  private minNotionalCache = new Map<string, number>();
  private defaultPrecision = 0;
  private defaultTickSize = 0.01;
  private defaultMinNotional = 10;

  public async preloadPrecisions(): Promise<void> {
    try {
      const response = await fetch("https://api.binance.com/api/v3/exchangeInfo");
      if (response.ok) {
        const data: any = await response.json();
        for (const item of data.symbols) {
          const lotSizeFilter = item.filters.find((f: any) => f.filterType === "LOT_SIZE");
          if (lotSizeFilter && lotSizeFilter.stepSize) {
            const stepSizeStr = parseFloat(lotSizeFilter.stepSize).toString();
            let decimals = 0;
            if (stepSizeStr.includes(".")) {
              decimals = stepSizeStr.split(".")[1]!.length;
            } else if (stepSizeStr.includes("e-")) {
              decimals = parseInt(stepSizeStr.split("e-")[1]!, 10);
            }
            this.quantityPrecisionCache.set(item.symbol.toUpperCase(), decimals);
          }

          const priceFilter = item.filters.find((f: any) => f.filterType === "PRICE_FILTER");
          if (priceFilter && priceFilter.tickSize) {
            this.priceTickSizeCache.set(item.symbol.toUpperCase(), parseFloat(priceFilter.tickSize));
          }

          const notionalFilter = item.filters.find((f: any) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
          if (notionalFilter && notionalFilter.minNotional) {
            this.minNotionalCache.set(item.symbol.toUpperCase(), parseFloat(notionalFilter.minNotional));
          }
        }
        console.log(`✅ Preloaded precision, tickSize and minNotional filters for ${this.quantityPrecisionCache.size} symbols from Binance API.`);
      } else {
        console.warn(`⚠️ Failed to preload exchangeInfo: HTTP ${response.status}`);
      }
    } catch (e) {
      console.warn("⚠️ Error during precision preload", e);
    }
  }

  public getQuantityDecimals(symbol: string): number {
    return this.quantityPrecisionCache.get(symbol.toUpperCase()) ?? this.defaultPrecision;
  }

  public getPriceTickSize(symbol: string): number {
    return this.priceTickSizeCache.get(symbol.toUpperCase()) ?? this.defaultTickSize;
  }

  public getMinNotional(symbol: string): number {
    return this.minNotionalCache.get(symbol.toUpperCase()) ?? this.defaultMinNotional;
  }
}
