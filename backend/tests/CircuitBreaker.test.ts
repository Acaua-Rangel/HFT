import { describe, expect, it } from "bun:test";
import { CircuitBreaker } from "../src/application/mm/CircuitBreaker";
import { VolatilityMonitor } from "../src/application/mm/VolatilityMonitor";
import { LiquidityMonitor } from "../src/application/mm/LiquidityMonitor";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";

describe("CircuitBreaker", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

    it("should pause if latency is too high", () => {
        const stateManager = new LocalStateManager();
        const volMonitor = new VolatilityMonitor(stateManager);
        const liqMonitor = new LiquidityMonitor(stateManager);
        
        const cb = new CircuitBreaker(volMonitor, liqMonitor, () => 600); // 600ms latency
        expect(cb.shouldPause(pair)).toBeTrue();
    });

    it("should not pause if latency is normal and monitors are calm", () => {
        const stateManager = new LocalStateManager();
        const volMonitor = new VolatilityMonitor(stateManager);
        const liqMonitor = new LiquidityMonitor(stateManager);
        
        volMonitor.shouldPause = () => false;
        liqMonitor.shouldPause = () => false;

        const cb = new CircuitBreaker(volMonitor, liqMonitor, () => 100); 
        expect(cb.shouldPause(pair)).toBeFalse();
    });

    it("should pause if volatility monitor vetoes", () => {
        const stateManager = new LocalStateManager();
        const volMonitor = new VolatilityMonitor(stateManager);
        const liqMonitor = new LiquidityMonitor(stateManager);
        
        volMonitor.shouldPause = () => true;
        liqMonitor.shouldPause = () => false;

        const cb = new CircuitBreaker(volMonitor, liqMonitor, () => 100); 
        expect(cb.shouldPause(pair)).toBeTrue();
    });

    it("should pause if liquidity monitor vetoes", () => {
        const stateManager = new LocalStateManager();
        const volMonitor = new VolatilityMonitor(stateManager);
        const liqMonitor = new LiquidityMonitor(stateManager);
        
        volMonitor.shouldPause = () => false;
        liqMonitor.shouldPause = () => true;

        const cb = new CircuitBreaker(volMonitor, liqMonitor, () => 100); 
        expect(cb.shouldPause(pair)).toBeTrue();
    });
});
