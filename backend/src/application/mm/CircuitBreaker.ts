import { Pair } from "../../domain/valueObjects/Pair";
import { VolatilityMonitor } from "./VolatilityMonitor";
import { LiquidityMonitor } from "./LiquidityMonitor";

export class CircuitBreaker {
    // Veto if WS latency exceeds 500ms
    public MAX_LATENCY_MS = 500;

    /**
     * @param getLatency Latência de ida e volta até a exchange, em ms, ou `null` quando a
     *   medida não se aplica. A trava de latência protege a EXECUÇÃO AO VIVO: uma ordem
     *   enviada com atraso é preenchida a um preço que já não é o que cotamos. Num
     *   backtest nenhuma ordem viaja até a exchange, então o RTT de rede é irrelevante —
     *   e pior, a medição fica corrompida, porque o laço do backtest é síncrono e só cede
     *   o event loop a cada 1000 ticks, inflando o tempo observado do ping com starvation
     *   em vez de rede. Passar `null` nesses casos evita vetar o backtest inteiro.
     */
    constructor(
        private volatilityMonitor: VolatilityMonitor,
        private liquidityMonitor: LiquidityMonitor,
        private getLatency: () => number | null
    ) {}

    public shouldPause(pair: Pair): boolean {
        const latency = this.getLatency();
        if (latency !== null && latency > this.MAX_LATENCY_MS) {
            console.log(`⚠️ Circuit Breaker Veto: High Latency (${latency}ms > ${this.MAX_LATENCY_MS}ms)`);
            return true;
        }

        if (this.volatilityMonitor.shouldPause(pair)) {
            return true;
        }

        if (this.liquidityMonitor.shouldPause(pair)) {
            return true;
        }

        return false;
    }
}
