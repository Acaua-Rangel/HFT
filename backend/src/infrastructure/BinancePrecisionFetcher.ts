export class BinancePrecisionFetcher {
  private quantityPrecisionCache = new Map<string, number>();
  private defaultPrecision = 0;

  public async preloadPrecisions(): Promise<void> {
    try {
      const response = await fetch("https://api.binance.com/api/v3/exchangeInfo");
      if (response.ok) {
        const data = await response.json();
        for (const item of data.symbols) {
          const lotSizeFilter = item.filters.find((f: any) => f.filterType === "LOT_SIZE");
          if (lotSizeFilter && lotSizeFilter.stepSize) {
            const stepSizeStr = parseFloat(lotSizeFilter.stepSize).toString();
            let decimals = 0;
            if (stepSizeStr.includes(".")) {
              decimals = stepSizeStr.split(".")[1].length;
            } else if (stepSizeStr.includes("e-")) {
              decimals = parseInt(stepSizeStr.split("e-")[1], 10);
            }
            this.quantityPrecisionCache.set(item.symbol.toUpperCase(), decimals);
          }
        }
        console.log(`✅ Preloaded precision filters for ${this.quantityPrecisionCache.size} symbols from Binance API.`);
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
}
