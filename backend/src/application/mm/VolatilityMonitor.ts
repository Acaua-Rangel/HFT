import { Amount } from "../../domain/valueObjects/Amount";
import { LocalStateManager } from "../LocalStateManager";
import { Pair } from "../../domain/valueObjects/Pair";

export class VolatilityMonitor {
    private readonly WINDOW_MS = 60000; // 60 seconds
    private readonly THRESHOLD = 0.005; // 0.5% standard deviation over mean

    private priceHistory: { ts: number; price: number }[] = [];

    constructor(private stateManager: LocalStateManager) {}

    public shouldPause(pair: Pair): boolean {
        const book = this.stateManager.retrieveOrderBook(pair);
        if (!book) return false;
        const latest = book.getLatest();
        if (!latest) return false;
        
        let mid = 0;
        const midPriceAmount = latest.getMidPrice();
        if (!midPriceAmount) return false;
        midPriceAmount.apply((v: number) => mid = v);
        
        const now = Date.now();
        this.priceHistory.push({ ts: now, price: mid });
        this.priceHistory = this.priceHistory.filter(h => now - h.ts <= this.WINDOW_MS);

        if (this.priceHistory.length < 10) {
            // Not enough data to determine volatility
            return false;
        }

        const prices = this.priceHistory.map(h => h.price);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        
        const variance = prices.reduce((acc, p) => acc + Math.pow(p - mean, 2), 0) / prices.length;
        const stddev = Math.sqrt(variance);

        const volatilityPercentage = stddev / mean;
        
        if (volatilityPercentage > this.THRESHOLD) {
            console.log(`⚠️ Volatility Monitor Veto: Volatility at ${(volatilityPercentage * 100).toFixed(4)}% (Limit: ${(this.THRESHOLD * 100).toFixed(4)}%)`);
            return true;
        }

        return false;
    }
}
