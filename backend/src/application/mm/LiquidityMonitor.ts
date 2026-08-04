import { LocalStateManager } from "../LocalStateManager";
import { Pair } from "../../domain/valueObjects/Pair";

export class LiquidityMonitor {
    // Check if the top level has at least a minimal healthy volume
    // E.g., at least $50 available directly at the top of the book
    private readonly MIN_NOTIONAL = 50;

    constructor(private stateManager: LocalStateManager) {}

    public shouldPause(pair: Pair): boolean {
        const book = this.stateManager.retrieveOrderBook(pair);
        if (!book) return true; // No liquidity at all
        const latest = book.getLatest();
        if (!latest) return true;

        let bidVolume = 0;
        let askVolume = 0;

        latest.applyTopBid((bid) => {
            if (bid) {
                let px = 0; let qx = 0;
                bid.price.apply(v => px = v); bid.qty.apply(v => qx = v);
                bidVolume = px * qx;
            }
        });

        latest.applyTopAsk((ask) => {
            if (ask) {
                let px = 0; let qx = 0;
                ask.price.apply(v => px = v); ask.qty.apply(v => qx = v);
                askVolume = px * qx;
            }
        });

        if (bidVolume < this.MIN_NOTIONAL || askVolume < this.MIN_NOTIONAL) {
            console.log(`⚠️ Liquidity Monitor Veto: Top level too thin. Bids: $${bidVolume.toFixed(0)}, Asks: $${askVolume.toFixed(0)}`);
            return true;
        }

        return false;
    }
}
