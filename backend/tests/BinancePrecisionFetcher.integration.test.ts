import { test, expect, describe } from "bun:test";
import { BinancePrecisionFetcher } from "../src/infrastructure/BinancePrecisionFetcher";

describe("BinancePrecisionFetcher Integration Tests", () => {
  test("Should fetch and parse exchangeInfo from Binance API successfully", async () => {
    const fetcher = new BinancePrecisionFetcher();
    
    // Call the actual Binance API
    await fetcher.preloadPrecisions();
    
    // Test that the cache was populated with realistic data
    // BTCUSDT usually has a LOT_SIZE stepSize of 0.00001 (5 decimals)
    const btcDecimals = fetcher.getQuantityDecimals("BTCUSDT");
    expect(btcDecimals).toBeGreaterThanOrEqual(2);
    expect(btcDecimals).toBeLessThanOrEqual(8);

    // ETHUSDT usually has a LOT_SIZE stepSize of 0.0001 (4 decimals)
    const ethDecimals = fetcher.getQuantityDecimals("ETHUSDT");
    expect(ethDecimals).toBeGreaterThanOrEqual(2);
    expect(ethDecimals).toBeLessThanOrEqual(8);

    // SHIBUSDT usually has a LOT_SIZE stepSize of 1 (0 decimals)
    const shibDecimals = fetcher.getQuantityDecimals("SHIBUSDT");
    expect(shibDecimals).toBe(0);

    // Test a non-existent symbol fallback
    const unknownDecimals = fetcher.getQuantityDecimals("THIS_PAIR_DOES_NOT_EXIST");
    expect(unknownDecimals).toBe(0);
  });
});
