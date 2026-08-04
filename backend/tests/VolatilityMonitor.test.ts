import { describe, expect, it } from "bun:test";
import { VolatilityMonitor } from "../src/application/mm/VolatilityMonitor";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Tick, Level } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";

describe("VolatilityMonitor", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

    it("should return 0 volatility when there is no orderbook data", () => {
        const stateManager = new LocalStateManager();
        const monitor = new VolatilityMonitor(stateManager);
        expect(monitor.getVolatilityPercentage(pair)).toBe(0);
    });

    it("should return 0 volatility when there are less than 10 prices in history", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        
        const asks: Level[] = [{ price: new Amount(1001), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(999), qty: new Amount(1) }];
        stateManager.updateState(new Tick(pair, asks, bids));

        const monitor = new VolatilityMonitor(stateManager);
        
        for (let i = 0; i < 5; i++) {
            monitor.getVolatilityPercentage(pair);
        }

        expect(monitor.getVolatilityPercentage(pair)).toBe(0);
    });

    it("should calculate volatility properly with more than 10 ticks", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new VolatilityMonitor(stateManager);
        
        const prices = [100, 101, 102, 99, 98, 100, 101, 100, 99, 100, 105];
        
        for (const p of prices) {
            const asks: Level[] = [{ price: new Amount(p + 1), qty: new Amount(1) }];
            const bids: Level[] = [{ price: new Amount(p - 1), qty: new Amount(1) }];
            stateManager.updateState(new Tick(pair, asks, bids));
            monitor.getVolatilityPercentage(pair);
        }

        const vol = monitor.getVolatilityPercentage(pair);
        expect(vol).toBeGreaterThan(0);
    });

    it("should pause if volatility exceeds limit", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new VolatilityMonitor(stateManager);
        
        const prices = [100, 120, 80, 150, 70, 110, 90, 130, 80, 100, 150];
        
        for (const p of prices) {
            const asks: Level[] = [{ price: new Amount(p + 1), qty: new Amount(1) }];
            const bids: Level[] = [{ price: new Amount(p - 1), qty: new Amount(1) }];
            stateManager.updateState(new Tick(pair, asks, bids));
            monitor.getVolatilityPercentage(pair);
        }

        expect(monitor.shouldPause(pair)).toBeTrue();
    });
});
