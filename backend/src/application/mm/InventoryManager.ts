export class InventoryManager {
    // We use a simplified Avellaneda-Stoikov where risk aversion shifts the reservation price.
    public GAMMA = 0.1; // Risk aversion
    public MAX_INVENTORY_SKEW = 0.40; // 0.5 + 0.4 = 90% (Pause quoting side if exceeded)
    public BASE_SPREAD_PCT = 0.001; // 0.1% baseline spread

    public baseBalance: number = 0;
    public quoteBalance: number = 0;

    constructor() {}

    public getQuotes(midPrice: number): { bid: number, ask: number, bidEnabled: boolean, askEnabled: boolean, q: number, reservationPrice: number } {
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

        // Scaled gamma so that maximum q (0.5) with gamma 0.1 results in a 0.5% price skew.
        const scaledGamma = this.GAMMA * 0.1; 
        const reservationPrice = midPrice - (q * scaledGamma * midPrice);

        const halfSpread = (midPrice * this.BASE_SPREAD_PCT) / 2;
        const bid = reservationPrice - halfSpread;
        const ask = reservationPrice + halfSpread;

        return { bid, ask, bidEnabled, askEnabled, q, reservationPrice };
    }
}
