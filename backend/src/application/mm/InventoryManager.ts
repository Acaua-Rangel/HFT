export class InventoryManager {
    // We use a simplified Avellaneda-Stoikov where risk aversion shifts the reservation price.
    public GAMMA = 0.1; // Risk aversion (inventory penalty)
    public MAX_INVENTORY_SKEW = 0.40; // 0.5 + 0.4 = 90% (Pause quoting side if exceeded)

    // Adaptive Spread Parameters (all auto-calculated, no manual input needed)
    // SAFETY_MULTIPLIER: How many times the measured volatility the spread must cover.
    // At 3.0x, if volatility is 0.02%, spread = 0.06%. This covers ~99.7% of price movements (3-sigma).
    public SAFETY_MULTIPLIER = 3.0;
    // ABSOLUTE_MIN_SPREAD: Hard floor to prevent zero-spread in dead markets (0.01% = 1 basis point)
    public ABSOLUTE_MIN_SPREAD = 0.0001;

    // Legacy field kept for dashboard compatibility — now auto-calculated, not used as primary spread
    public BASE_SPREAD_PCT = 0.001;

    public baseBalance: number = 0;
    public quoteBalance: number = 0;

    constructor() {}

    /**
     * Calculates adaptive spread and quote prices based on real-time market data.
     * 
     * The spread is computed as:
     *   spread = max(
     *     ABSOLUTE_MIN_SPREAD,              // Hard floor (0.01%)
     *     2 * feeRate * 1.5,                // Fee floor: covers round-trip fees + 50% margin
     *     SAFETY_MULTIPLIER * volatilityPct  // Volatility floor: covers price risk during holding period
     *   )
     * 
     * This guarantees that the spread ALWAYS exceeds the cost of:
     * 1. Paying fees (both legs of the trade)
     * 2. The expected adverse price movement while holding inventory
     * 3. A minimum floor for ultra-quiet markets
     */
    public getQuotes(
        midPrice: number, 
        feeRate: number = 0.001, 
        volatilityPct: number = 0, 
        isZeroFee: boolean = false, 
        bestBid: number = 0, 
        bestAsk: number = 0
    ): { 
        bid: number, ask: number, bidEnabled: boolean, askEnabled: boolean, 
        q: number, reservationPrice: number, effectiveSpread: number, minSpreadFloor: number, 
        bidDistancePct: number, askDistancePct: number, bidDistanceAbs: number, askDistanceAbs: number 
    } {
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

        // === ADAPTIVE SPREAD CALCULATION ===
        // 1. Fee floor: covers round-trip fees with 50% safety margin
        const feeFloor = feeRate > 0 ? 2 * feeRate * 1.5 : 0;

        // 2. Volatility floor: covers expected price movement during holding period
        //    volatilityPct = stddev(prices) / mean(prices) over 60s window
        //    SAFETY_MULTIPLIER scales it to cover worst-case movements (3-sigma by default)
        const volatilityFloor = this.SAFETY_MULTIPLIER * volatilityPct;

        // 3. Absolute minimum: prevents zero-spread in ultra-quiet markets
        const absoluteFloor = this.ABSOLUTE_MIN_SPREAD;

        // Final spread = the maximum of all three floors
        const minSpreadFloor = Math.max(feeFloor, volatilityFloor, absoluteFloor);
        const effectiveSpread = minSpreadFloor;
        const baseHalfSpread = effectiveSpread / 2;

        // === ASYMMETRIC SPREAD ADJUSTMENT (inventory skew) ===
        let bidDistance = baseHalfSpread;
        let askDistance = baseHalfSpread;
        
        // GAMMA * 10 as scaler: GAMMA 0.1 -> 1x multiplier per max q(0.5)
        const skewScaler = this.GAMMA * 10;

        if (q > 0) {
            // Long base asset: Widen bid (harder to buy more), tighten ask (easier to sell)
            bidDistance = baseHalfSpread * (1 + q * skewScaler);
            askDistance = Math.max(absoluteFloor / 2, baseHalfSpread * (1 - q * skewScaler));
        } else if (q < 0) {
            // Short base asset: Tighten bid (easier to buy), widen ask (harder to sell)
            bidDistance = Math.max(absoluteFloor / 2, baseHalfSpread * (1 - Math.abs(q) * skewScaler));
            askDistance = baseHalfSpread * (1 + Math.abs(q) * skewScaler);
        }

        bidDistance = Math.max(0, bidDistance);
        askDistance = Math.max(0, askDistance);

        const bid = midPrice * (1 - bidDistance);
        const ask = midPrice * (1 + askDistance);

        // Reservation price for telemetry
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
