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

    // Advanced Hummingbot Order Levels
    // 3 níveis com fatores 1/1.5/2 exigem 4.5× o lote base por lado. Com capital pequeno
    // cada nível cai abaixo do notional mínimo da exchange e o lado inteiro é bloqueado.
    // Default do Hummingbot para pure market making é 1; suba conforme o capital crescer.
    public ORDER_LEVELS = 1;
    public LEVEL_SPREAD_STEP = 0.0005; // 0.05%
    public LEVEL_AMOUNT_FACTOR = 0.5; // Level 0: 1x, Level 1: 1.5x, Level 2: 2.0x

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
        bestAsk: number = 0,
        k: number = 1.5
    ): { 
        bids: { price: number, amountFactor: number }[], 
        asks: { price: number, amountFactor: number }[], 
        bidEnabled: boolean, askEnabled: boolean, 
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
        // Trade intensity (k) is now passed in as a parameter (dynamic)
        const variance = volatilityPct * volatilityPct;
        const timeHorizon = 1.0; 

        // 1. Reservation Price (r)
        // Para que o GAMMA (Risk Aversion) tenha um impacto real e intuitivo, o ajuste de preço 
        // agora escala linearmente com a volatilidade (stddev) em vez da variância, pois a variância (sigma^2)
        // de pequenas porcentagens (ex: 0.1%) é virtualmente zero (0.000001).
        // Se GAMMA = 1.0 e skew máximo (q=0.5), o preço se desloca exatamente o tamanho da volatilidade atual.
        const reservationPrice = midPrice * (1 - q * this.GAMMA * volatilityPct * 2);

        // 2. Optimal Spread (delta)
        // Usamos uma aproximação do spread de Avellaneda + BASE_SPREAD_PCT para que o controle manual funcione.
        const avellanedaSpreadPct = this.BASE_SPREAD_PCT + (this.GAMMA * variance * timeHorizon) + ((2 / Math.max(this.GAMMA, 0.01)) * Math.log(1 + (this.GAMMA / k))) / 1000;

        // === SAFETY FLOORS ===
        const feeFloor = feeRate > 0 ? 2 * feeRate * 1.5 : 0;
        const absoluteFloor = this.ABSOLUTE_MIN_SPREAD;
        const volatilityFloor = this.SAFETY_MULTIPLIER * volatilityPct;

        const minSpreadFloor = Math.max(feeFloor, volatilityFloor, absoluteFloor, this.BASE_SPREAD_PCT);
        const effectiveSpread = Math.max(avellanedaSpreadPct, minSpreadFloor);
        const baseHalfSpread = effectiveSpread / 2;

        let bids: { price: number, amountFactor: number }[] = [];
        let asks: { price: number, amountFactor: number }[] = [];

        for (let i = 0; i < this.ORDER_LEVELS; i++) {
            const levelSpreadAdd = i * this.LEVEL_SPREAD_STEP;
            const amountFactor = 1 + (i * this.LEVEL_AMOUNT_FACTOR);
            bids.push({
                price: reservationPrice * (1 - baseHalfSpread - levelSpreadAdd),
                amountFactor
            });
            asks.push({
                price: reservationPrice * (1 + baseHalfSpread + levelSpreadAdd),
                amountFactor
            });
        }

        // Top-of-book distance metrics
        let bidDistancePct = 0;
        let askDistancePct = 0;
        let bidDistanceAbs = 0;
        let askDistanceAbs = 0;

        if (bestBid > 0 && bids.length > 0) {
            bidDistancePct = (bestBid - bids[0]!.price) / bestBid * 100;
            bidDistanceAbs = bestBid - bids[0]!.price;
        }
        if (bestAsk > 0 && asks.length > 0) {
            askDistancePct = (asks[0]!.price - bestAsk) / bestAsk * 100;
            askDistanceAbs = asks[0]!.price - bestAsk;
        }

        return { bids, asks, bidEnabled, askEnabled, q, reservationPrice, effectiveSpread, minSpreadFloor, bidDistancePct, askDistancePct, bidDistanceAbs, askDistanceAbs };
    }
}
