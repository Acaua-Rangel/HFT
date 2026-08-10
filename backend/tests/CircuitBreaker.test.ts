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

    // Regressão: o backtest era vetado inteiro por "High Latency". A trava de latência
    // protege a execução ao vivo; num backtest nenhuma ordem viaja até a exchange, e a
    // medição ainda fica inflada pelo laço síncrono da simulação (starvation do event
    // loop lida como se fosse rede). `null` sinaliza "não aplicável".
    it("should skip the latency check entirely when latency is not applicable (null)", () => {
        const stateManager = new LocalStateManager();
        const volMonitor = new VolatilityMonitor(stateManager);
        const liqMonitor = new LiquidityMonitor(stateManager);

        volMonitor.shouldPause = () => false;
        liqMonitor.shouldPause = () => false;

        const cb = new CircuitBreaker(volMonitor, liqMonitor, () => null);
        expect(cb.shouldPause(pair)).toBeFalse();
    });

    it("should still honour the other monitors when latency is not applicable", () => {
        const stateManager = new LocalStateManager();
        const volMonitor = new VolatilityMonitor(stateManager);
        const liqMonitor = new LiquidityMonitor(stateManager);

        volMonitor.shouldPause = () => true;
        liqMonitor.shouldPause = () => false;

        const cb = new CircuitBreaker(volMonitor, liqMonitor, () => null);
        expect(cb.shouldPause(pair)).toBeTrue();
    });

    it("should treat zero latency as a real measurement, not as absent", () => {
        const stateManager = new LocalStateManager();
        const volMonitor = new VolatilityMonitor(stateManager);
        const liqMonitor = new LiquidityMonitor(stateManager);

        volMonitor.shouldPause = () => false;
        liqMonitor.shouldPause = () => false;

        // 0 é falsy: uma checagem por truthiness trataria isso como "sem medida".
        const cb = new CircuitBreaker(volMonitor, liqMonitor, () => 0);
        expect(cb.shouldPause(pair)).toBeFalse();
    });
});
