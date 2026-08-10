import { BinancePriceIngestor } from "../../infrastructure/BinancePriceIngestor";
import { Pair } from "../../domain/valueObjects/Pair";
import { TimeProvider } from "../../infrastructure/TimeProvider";

export class TradeIntensityMonitor {
    private readonly WINDOW_MS = 60000; // 60 seconds
    private tradeHistory: { ts: number; volume: number }[] = [];

    constructor(ingestor: BinancePriceIngestor) {
        ingestor.onTrade((symbol, volume) => {
            this.tradeHistory.push({ ts: TimeProvider.now(), volume });
        });
    }

    public getK(pair: Pair): number {
        const now = TimeProvider.now();
        // Keep only trades within the window
        this.tradeHistory = this.tradeHistory.filter(t => now - t.ts <= this.WINDOW_MS);
        
        if (this.tradeHistory.length === 0) return 1.5; // Default baseline K

        const tradeCount = this.tradeHistory.length;
        const tradesPerSecond = tradeCount / (this.WINDOW_MS / 1000);
        
        // Calculate dynamic K based on frequency of trades.
        // Base K=5.0 (makes baseline spread tighter). If the market is frenetic, K increases faster.
        // Higher K shrinks the Avellaneda-Stoikov spread because order execution probability is higher.
        return Math.max(5.0, 5.0 + (tradesPerSecond * 2.0));
    }
}
