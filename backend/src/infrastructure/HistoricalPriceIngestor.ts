import { PriceIngestor } from "../domain/interfaces/PriceIngestor";
import { Pair } from "../domain/valueObjects/Pair";
import { Tick } from "../domain/valueObjects/Tick";
import { Amount } from "../domain/valueObjects/Amount";
import { HistoricalTickData } from "./BinanceHistoricalDownloader";
import { TimeProvider } from "./TimeProvider";

export class HistoricalPriceIngestor implements PriceIngestor {
    private callbacks: ((tick: Tick) => void)[] = [];
    private tradeCallbacks: ((symbol: string, volume: number) => void)[] = [];
    private subscriptions: Map<string, Pair> = new Map();

    public subscribe(pair: Pair): void {
        pair.applyBinanceSymbol((symbol: string) => {
            this.subscriptions.set(symbol.toUpperCase(), pair);
        });
    }

    public onTick(callback: (tick: Tick) => void): void {
        this.callbacks.push(callback);
    }

    public onTrade(callback: (symbol: string, volume: number) => void): void {
        this.tradeCallbacks.push(callback);
    }

    public emitHistoricalTick(data: HistoricalTickData): void {
        // Assume single pair simulation for now (or iterate if multiple)
        for (const [symbol, pair] of this.subscriptions.entries()) {
            // Update virtual time before emitting
            TimeProvider.setVirtualTime(data.timestamp);

            // Notify Trade
            this.tradeCallbacks.forEach(cb => cb(symbol, data.volume));

            // Generate synthetic Tick from price
            // Simulating a tight spread (e.g. 0.01% or absolute minimal)
            // A simple approximation is Bid = Price - epsilon, Ask = Price + epsilon
            const syntheticSpread = data.price * 0.00005; // 0.005% spread
            
            const bidPrice = new Amount(data.price - syntheticSpread);
            const askPrice = new Amount(data.price + syntheticSpread);
            const qty = new Amount(data.volume || 1); // Mock qty for the depth

            // Create depth 1 orderbook for the tick
            const bids = [{ price: bidPrice, qty: qty }];
            const asks = [{ price: askPrice, qty: qty }];

            const tick = new Tick(pair, asks, bids);
            this.callbacks.forEach(cb => cb(tick));
        }
    }
}
