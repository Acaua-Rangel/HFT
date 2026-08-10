import { afterEach, describe, expect, it } from "bun:test";
import { TrendMonitor } from "../src/application/mm/TrendMonitor";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Tick, Level } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";
import { TimeProvider } from "../src/infrastructure/TimeProvider";

describe("TrendMonitor", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("FDUSD"));

    // O tempo virtual é global. Deixá-lo setado vaza para os outros arquivos da suíte e
    // faz testes que comparam idade de ordem contra Date.now() calcularem idades negativas.
    afterEach(() => {
        TimeProvider.clearVirtualTime();
    });

    /** Alimenta o monitor com uma série de preços, um por segundo de tempo virtual. */
    function feed(monitor: TrendMonitor, stateManager: LocalStateManager, prices: number[], stepMs = 1000): void {
        let t = 1_700_000_000_000;
        for (const p of prices) {
            TimeProvider.setVirtualTime(t);
            const asks: Level[] = [{ price: new Amount(p + 1), qty: new Amount(1) }];
            const bids: Level[] = [{ price: new Amount(p - 1), qty: new Amount(1) }];
            stateManager.updateState(new Tick(pair, asks, bids));
            monitor.record(pair);
            t += stepMs;
        }
        TimeProvider.setVirtualTime(t);
    }

    function setup(): { monitor: TrendMonitor; stateManager: LocalStateManager } {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        return { monitor: new TrendMonitor(stateManager), stateManager };
    }

    it("returns 0 when there is no orderbook data", () => {
        const stateManager = new LocalStateManager();
        const monitor = new TrendMonitor(stateManager);
        expect(monitor.getTrendSignal(pair)).toBe(0);
    });

    it("returns 0 while the window is still filling (below MIN_SAMPLES)", () => {
        const { monitor, stateManager } = setup();
        feed(monitor, stateManager, [100, 99, 98, 97, 96]);
        expect(monitor.getTrendSignal(pair)).toBe(0);
    });

    it("reports a negative signal of the right magnitude on a sustained drop", () => {
        const { monitor, stateManager } = setup();
        // 100 -> 99: queda de 1%, ln(99/100) ≈ -0.01005
        const prices = Array.from({ length: 20 }, (_, i) => 100 - i * (1 / 19));
        feed(monitor, stateManager, prices);

        const signal = monitor.getTrendSignal(pair);
        expect(signal).toBeLessThan(0);
        expect(signal).toBeCloseTo(Math.log(99 / 100), 4);
    });

    it("reports a positive signal on a sustained rise", () => {
        const { monitor, stateManager } = setup();
        const prices = Array.from({ length: 20 }, (_, i) => 100 + i * (1 / 19));
        feed(monitor, stateManager, prices);

        expect(monitor.getTrendSignal(pair)).toBeGreaterThan(0);
    });

    it("stays near zero on a noisy sideways market", () => {
        const { monitor, stateManager } = setup();
        // Oscila em torno de 100 e volta ao ponto de partida.
        const prices = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 0.5);
        feed(monitor, stateManager, prices);

        expect(Math.abs(monitor.getTrendSignal(pair))).toBeLessThan(0.005);
    });

    it("is a pure getter: repeated calls return the same value", () => {
        const { monitor, stateManager } = setup();
        feed(monitor, stateManager, Array.from({ length: 20 }, (_, i) => 100 - i * 0.05));

        // Regressão do bug do VolatilityMonitor: o getter mutava o histórico e era chamado
        // 2–3× por ciclo, então a estimativa dependia da contagem de chamadas.
        const first = monitor.getTrendSignal(pair);
        expect(monitor.getTrendSignal(pair)).toBe(first);
        expect(monitor.getTrendSignal(pair)).toBe(first);
    });

    it("drops samples that fall outside the window", () => {
        const { monitor, stateManager } = setup();
        // 20 amostras espaçadas de 60s cobrem 19 min, muito além da janela de 5 min:
        // as antigas precisam sair, senão o sinal mediria a série inteira.
        const prices = Array.from({ length: 20 }, (_, i) => 100 - i);
        feed(monitor, stateManager, prices, 60000);

        // Sobrando só a cauda recente, o sinal reflete os últimos ~5 min, não a queda toda
        // de 100 para 81 (que seria ln(81/100) ≈ -0.21).
        const signal = monitor.getTrendSignal(pair);
        expect(signal).toBeGreaterThan(-0.15);
    });

    it("exposes downtrend and flatten thresholds consistently with the signal", () => {
        const { monitor, stateManager } = setup();
        // Queda de ~2%: passa dos dois limiares (0,4% e 1,0%).
        const prices = Array.from({ length: 20 }, (_, i) => 100 - i * (2 / 19));
        feed(monitor, stateManager, prices);

        expect(monitor.isDowntrend(pair)).toBeTrue();
        expect(monitor.shouldFlatten(pair)).toBeTrue();
    });

    it("does not flag a downtrend on a mild drift below the threshold", () => {
        const { monitor, stateManager } = setup();
        // Queda de 0,1%, abaixo do TREND_THRESHOLD de 0,4%.
        const prices = Array.from({ length: 20 }, (_, i) => 100 - i * (0.1 / 19));
        feed(monitor, stateManager, prices);

        expect(monitor.isDowntrend(pair)).toBeFalse();
        expect(monitor.shouldFlatten(pair)).toBeFalse();
    });
});
