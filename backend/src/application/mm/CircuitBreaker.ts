import { Pair } from "../../domain/valueObjects/Pair";
import { VolatilityMonitor } from "./VolatilityMonitor";
import { LiquidityMonitor } from "./LiquidityMonitor";

export class CircuitBreaker {
    // Veto if WS latency exceeds 500ms
    private readonly MAX_LATENCY_MS = 500;

    constructor(
        private volatilityMonitor: VolatilityMonitor,
        private liquidityMonitor: LiquidityMonitor,
        private getLatency: () => number
    ) {}

    public shouldPause(pair: Pair): boolean {
        const latency = this.getLatency();
        if (latency > this.MAX_LATENCY_MS) {
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
