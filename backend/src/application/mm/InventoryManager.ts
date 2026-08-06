export class InventoryManager {
    // We use a simplified Avellaneda-Stoikov where risk aversion shifts the reservation price.
    public GAMMA = 0.1; // Risk aversion
    public MAX_INVENTORY_SKEW = 0.40; // 0.5 + 0.4 = 90% (Pause quoting side if exceeded)
    public BASE_SPREAD_PCT = 0.001; // 0.1% baseline spread

    public baseBalance: number = 0;
    public quoteBalance: number = 0;

    constructor() {}

    public getQuotes(midPrice: number, feeRate: number = 0.001, volatilityPct: number = 0, isZeroFee: boolean = false, bestBid: number = 0, bestAsk: number = 0): { bid: number, ask: number, bidEnabled: boolean, askEnabled: boolean, q: number, reservationPrice: number, effectiveSpread: number, minSpreadFloor: number, bidDistancePct: number, askDistancePct: number, bidDistanceAbs: number, askDistanceAbs: number } {
        const baseWealth = this.baseBalance * midPrice;
        const totalWealth = baseWealth + this.quoteBalance;

        let q = 0;
        let bidEnabled = true;
        let askEnabled = true;

        if (totalWealth <= 0) {
            bidEnabled = false;
            askEnabled = false;
        } else {
            const baseRatio = baseWealth / totalWealth;
            q = baseRatio - 0.5; // Ranges from -0.5 (all quote) to +0.5 (all base)

            if (q > this.MAX_INVENTORY_SKEW) {
                bidEnabled = false;
            }
            if (q < -this.MAX_INVENTORY_SKEW) {
                askEnabled = false;
            }
        }

        // 1. Fee-Aware Dynamic Floor
        const minSpreadFloor = feeRate > 0 ? 2 * feeRate * 1.5 : 0;

        // 2. Volatility-Adjusted Spread
        const baselineVol = 0.001; 
        let volatilityMultiplier = 1;
        if (volatilityPct > baselineVol) {
            volatilityMultiplier = 1 + ((volatilityPct - baselineVol) / baselineVol);
        }
        
        const zeroFeeSpread = 0.00015; // 0.015% — tight spread for zero-fee pairs
        const spreadBase = isZeroFee ? zeroFeeSpread : this.BASE_SPREAD_PCT;
        const effectiveSpread = Math.max(spreadBase, minSpreadFloor) * volatilityMultiplier;
        const baseHalfSpread = effectiveSpread / 2;

        // 3. Asymmetric Spread Adjustment
        let bidDistance = baseHalfSpread;
        let askDistance = baseHalfSpread;
        
        // We use GAMMA * 10 as a scaler so that GAMMA 0.1 -> 1x multiplier per max q(0.5)
        const skewScaler = this.GAMMA * 10;

        if (q > 0) {
            // Long base asset: Widen bid (harder to buy), tighten ask (easier to sell)
            bidDistance = baseHalfSpread * (1 + q * skewScaler);
            askDistance = Math.max(minSpreadFloor / 2, baseHalfSpread * (1 - q * skewScaler));
        } else if (q < 0) {
            // Short base asset: Tighten bid (easier to buy), widen ask (harder to sell)
            bidDistance = Math.max(minSpreadFloor / 2, baseHalfSpread * (1 - Math.abs(q) * skewScaler));
            askDistance = baseHalfSpread * (1 + Math.abs(q) * skewScaler);
        }

        bidDistance = Math.max(0, bidDistance);
        askDistance = Math.max(0, askDistance);

        const bid = midPrice * (1 - bidDistance);
        const ask = midPrice * (1 + askDistance);

        // Keeping reservationPrice logic compatible (just pseudo-mid for telemetry if needed)
        const reservationPrice = midPrice * (1 - q * this.GAMMA * 0.1); 

        // Top-of-book distance metrics
        let bidDistancePct = 0;
        let askDistancePct = 0;
        let bidDistanceAbs = 0;
        let askDistanceAbs = 0;

        if (bestBid > 0) {
            bidDistancePct = (bestBid - bid) / bestBid * 100;
            bidDistanceAbs = bestBid - bid;
        }
        if (bestAsk > 0) {
            askDistancePct = (ask - bestAsk) / bestAsk * 100;
            askDistanceAbs = ask - bestAsk;
        }

        return { bid, ask, bidEnabled, askEnabled, q, reservationPrice, effectiveSpread, minSpreadFloor, bidDistancePct, askDistancePct, bidDistanceAbs, askDistanceAbs };
    }
}
