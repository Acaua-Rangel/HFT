import { BinancePriceIngestor } from "../../infrastructure/BinancePriceIngestor";
import { Pair } from "../../domain/valueObjects/Pair";

export class TradeIntensityMonitor {
    private readonly WINDOW_MS = 60000; // 60 seconds
    private tradeHistory: { ts: number; volume: number }[] = [];

    constructor(ingestor: BinancePriceIngestor) {
        ingestor.onTrade((symbol, volume) => {
            this.tradeHistory.push({ ts: Date.now(), volume });
        });
    }

    public getK(pair: Pair): number {
        const now = Date.now();
        // Keep only trades within the window
        this.tradeHistory = this.tradeHistory.filter(t => now - t.ts <= this.WINDOW_MS);
        
        if (this.tradeHistory.length === 0) return 1.5; // Default baseline K

        const tradeCount = this.tradeHistory.length;
        const tradesPerSecond = tradeCount / (this.WINDOW_MS / 1000);
        
        // Calculate dynamic K based on frequency of trades.
        // Base K=1.5. If the market is frenetic (e.g., 10 trades/sec), K increases (1.5 + 10 * 0.1 = 2.5)
        // Higher K shrinks the Avellaneda-Stoikov spread because order execution probability is higher.
        return Math.max(1.0, 1.0 + (tradesPerSecond * 0.1));
    }
}
