import { describe, expect, it } from "bun:test";
import { VolatilityMonitor } from "../src/application/mm/VolatilityMonitor";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Tick, Level } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";
import { TimeProvider } from "../src/infrastructure/TimeProvider";

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

    /** Alimenta o monitor com uma série de preços, um por segundo de tempo virtual. */
    function feed(monitor: VolatilityMonitor, stateManager: LocalStateManager, prices: number[]): void {
        let t = 1_700_000_000_000;
        for (const p of prices) {
            TimeProvider.setVirtualTime(t);
            const asks: Level[] = [{ price: new Amount(p + 1), qty: new Amount(1) }];
            const bids: Level[] = [{ price: new Amount(p - 1), qty: new Amount(1) }];
            stateManager.updateState(new Tick(pair, asks, bids));
            monitor.record(pair);
            t += 1000;
        }
        TimeProvider.setVirtualTime(t);
    }

    it("should calculate volatility properly with more than 10 ticks", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new VolatilityMonitor(stateManager);

        feed(monitor, stateManager, [100, 101, 102, 99, 98, 100, 101, 100, 99, 100, 105]);

        expect(monitor.getVolatilityPercentage(pair)).toBeGreaterThan(0);
        TimeProvider.clearVirtualTime();
    });

    it("should pause if volatility exceeds limit", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new VolatilityMonitor(stateManager);

        feed(monitor, stateManager, [100, 120, 80, 150, 70, 110, 90, 130, 80, 100, 150]);

        expect(monitor.shouldPause(pair)).toBeTrue();
        TimeProvider.clearVirtualTime();
    });

    it("should not sample on read: the getter must be pure", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new VolatilityMonitor(stateManager);

        const asks: Level[] = [{ price: new Amount(101), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(99), qty: new Amount(1) }];
        stateManager.updateState(new Tick(pair, asks, bids));

        // 50 leituras não podem construir histórico; só record() amostra. Antes o getter
        // mutava o estado e a estimativa dependia de quantas vezes fora chamado.
        for (let i = 0; i < 50; i++) monitor.getVolatilityPercentage(pair);
        expect(monitor.getVolatilityPercentage(pair)).toBe(0);
    });

    it("should be insensitive to a clean trend without noise", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const trending = new VolatilityMonitor(stateManager);

        // Rampa perfeitamente linear: retornos praticamente constantes, volatilidade baixa.
        // A medida antiga (dispersão do nível sobre a média) explodia justamente aqui.
        const ramp = Array.from({ length: 30 }, (_, i) => 100 + i);
        feed(trending, stateManager, ramp);
        const trendVol = trending.getVolatilityPercentage(pair);

        const chopManager = new LocalStateManager();
        chopManager.registerPair(pair);
        const choppy = new VolatilityMonitor(chopManager);
        const chop = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 8 : -8));
        feed(choppy, chopManager, chop);
        const chopVol = choppy.getVolatilityPercentage(pair);

        expect(chopVol).toBeGreaterThan(trendVol);
        TimeProvider.clearVirtualTime();
    });
});
