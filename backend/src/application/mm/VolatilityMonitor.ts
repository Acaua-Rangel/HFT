import { Amount } from "../../domain/valueObjects/Amount";
import { LocalStateManager } from "../LocalStateManager";
import { Pair } from "../../domain/valueObjects/Pair";
import { TimeProvider } from "../../infrastructure/TimeProvider";
export class VolatilityMonitor {
    private readonly WINDOW_MS = 60000; // 60 seconds
    private readonly THRESHOLD = 0.02; // 2.0% standard deviation over mean (increased to avoid false positives)

    private priceHistory: { ts: number; price: number }[] = [];

    constructor(private stateManager: LocalStateManager) {}

    public getVolatilityPercentage(pair: Pair): number {
        const book = this.stateManager.retrieveOrderBook(pair);
        if (!book) return 0;
        const latest = book.getLatest();
        if (!latest) return 0;
        
        let mid = 0;
        const midPriceAmount = latest.getMidPrice();
        if (!midPriceAmount) return 0;
        midPriceAmount.apply((v: number) => mid = v);
        
        const now = TimeProvider.now();
        this.priceHistory.push({ ts: now, price: mid });
        this.priceHistory = this.priceHistory.filter(h => now - h.ts <= this.WINDOW_MS);

        if (this.priceHistory.length < 10) {
            return 0; // Not enough data
        }

        const prices = this.priceHistory.map(h => h.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((acc, p) => acc + Math.pow(p - mean, 2), 0) / prices.length;
        const stddev = Math.sqrt(variance);

        return stddev / mean;
    }

    public shouldPause(pair: Pair): boolean {
        const volatilityPercentage = this.getVolatilityPercentage(pair);
        
        if (volatilityPercentage > this.THRESHOLD) {
            console.log(`⚠️ Volatility Monitor Veto: Volatility at ${(volatilityPercentage * 100).toFixed(4)}% (Limit: ${(this.THRESHOLD * 100).toFixed(4)}%)`);
            return true;
        }

        return false;
    }
}
