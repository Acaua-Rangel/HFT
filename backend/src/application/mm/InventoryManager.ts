export class InventoryManager {
    // We use a simplified Avellaneda-Stoikov where risk aversion shifts the reservation price.
    public GAMMA = 0.1; // Risk aversion (inventory penalty)
    public MAX_INVENTORY_SKEW = 0.40; // 0.5 + 0.4 = 90% (Pause quoting side if exceeded)

    // Adaptive Spread Parameters (all auto-calculated, no manual input needed)
    // SAFETY_MULTIPLIER: How many times the measured volatility the spread must cover.
    // At 5.0x, it is much more conservative and protects against sudden price swings.
    public SAFETY_MULTIPLIER = 5.0;
    // ABSOLUTE_MIN_SPREAD: Hard floor to prevent zero-spread in dead markets (0.05% = 5 basis points)
    public ABSOLUTE_MIN_SPREAD = 0.0005;

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

        // === TRUE AVELLANEDA-STOIKOV MATHEMATICS ===
        const k = 1.5; // Trade intensity (liquidity parameter)
        const variance = volatilityPct * volatilityPct;
        const timeHorizon = 1.0; 

        // 1. Reservation Price (r)
        // r = s - q * gamma * sigma^2 * T
        // We scale the variance impact by 100 to make it meaningful for typical crypto volatility percentages
        const reservationPrice = midPrice * (1 - q * this.GAMMA * variance * timeHorizon * 100);

        // 2. Optimal Spread (delta)
        // delta = gamma * sigma^2 * T + (2/gamma) * ln(1 + gamma/k)
        // Scaled by 1000 to output a reasonable base percentage (e.g. 0.00128 = 0.128%)
        const avellanedaSpreadPct = (this.GAMMA * variance * timeHorizon) + ((2 / this.GAMMA) * Math.log(1 + (this.GAMMA / k))) / 1000;

        // === SAFETY FLOORS ===
        const feeFloor = feeRate > 0 ? 2 * feeRate * 1.5 : 0;
        const absoluteFloor = this.ABSOLUTE_MIN_SPREAD;
        const volatilityFloor = this.SAFETY_MULTIPLIER * volatilityPct;

        const minSpreadFloor = Math.max(feeFloor, volatilityFloor, absoluteFloor);
        const effectiveSpread = Math.max(avellanedaSpreadPct, minSpreadFloor);
        const baseHalfSpread = effectiveSpread / 2;

        let bid = reservationPrice * (1 - baseHalfSpread);
        let ask = reservationPrice * (1 + baseHalfSpread);

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
