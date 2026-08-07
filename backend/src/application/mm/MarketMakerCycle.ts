import { Pair } from "../../domain/valueObjects/Pair";
import { OrderExecutor } from "../../domain/interfaces/OrderExecutor";
import { Amount } from "../../domain/valueObjects/Amount";
import { LocalStateManager } from "../LocalStateManager";
import { CircuitBreaker } from "./CircuitBreaker";
import { InventoryManager } from "./InventoryManager";

export class MarketMakerCycle {
    public lotConfig: { mode: "PERCENTAGE" | "FIXED", value: number } = { mode: "PERCENTAGE", value: 0.05 };
    
    public currentEffectiveBuyLotQuote: number = 0;
    public currentEffectiveSellLotQuote: number = 0;
    constructor(
        private stateManager: LocalStateManager,
        private circuitBreaker: CircuitBreaker,
        private inventoryManager: InventoryManager,
        public executor: OrderExecutor
    ) {}

    public async executeTick(pair: Pair, feeRate: number = 0.001, volatilityPct: number = 0, isZeroFee: boolean = false): Promise<void> {
        if (this.circuitBreaker.shouldPause(pair)) {
            return; // Paused by risk
        }

        const book = this.stateManager.retrieveOrderBook(pair);
        if (!book) return;
        const tick = book.getLatest();
        if (!tick) return;

        const midPriceAmount = tick.getMidPrice();
        if (!midPriceAmount) return;

        let midPrice = 0;
        midPriceAmount.apply(v => midPrice = v);
        if (midPrice <= 0) return;

        let bestBid = 0;
        let bestAsk = 0;
        tick.applyTopBid(l => { if (l) l.price.apply(v => bestBid = v); });
        tick.applyTopAsk(l => { if (l) l.price.apply(v => bestAsk = v); });

        let { bid, ask, bidEnabled, askEnabled, q } = this.inventoryManager.getQuotes(midPrice, feeRate, volatilityPct, isZeroFee, bestBid, bestAsk);

        // Enforce Post-Only limits: never cross the spread
        if (bestBid > 0) bid = Math.min(bid, bestBid);
        if (bestAsk > 0) ask = Math.max(ask, bestAsk);

        const totalWealth = (this.inventoryManager.baseBalance * midPrice) + this.inventoryManager.quoteBalance;
        const MAX_ORDER_VALUE = totalWealth * 0.60;

        let baseLotQuote = this.lotConfig.mode === "PERCENTAGE" 
            ? totalWealth * this.lotConfig.value 
            : this.lotConfig.value;

        // Limite mínimo de ordem (ex: R$ 10 ou 10 FDUSD)
        const MIN_ORDER_VALUE = 10;
        baseLotQuote = Math.max(baseLotQuote, MIN_ORDER_VALUE);
        baseLotQuote = Math.min(baseLotQuote, MAX_ORDER_VALUE);

        // Ajuste assimétrico de lote por inventário
        let buyLotQuote = baseLotQuote * Math.max(0.2, 1 - q * 1.5);
        let sellLotQuote = baseLotQuote * Math.max(0.2, 1 + q * 1.5);

        // Validar limites de saldo
        buyLotQuote = Math.min(buyLotQuote, this.inventoryManager.quoteBalance);
        let sellBaseQty = sellLotQuote / midPrice;
        sellBaseQty = Math.min(sellBaseQty, this.inventoryManager.baseBalance);

        this.currentEffectiveBuyLotQuote = buyLotQuote;
        this.currentEffectiveSellLotQuote = sellLotQuote;
        
        const promises: Promise<any>[] = [];

        if (bidEnabled && bid > 0 && buyLotQuote >= MIN_ORDER_VALUE) {
            const quoteToSpend = new Amount(buyLotQuote); 
            promises.push(this.executor.executeMakerBuy(pair, quoteToSpend, new Amount(bid), 1000));
        }

        if (askEnabled && ask > 0 && (sellBaseQty * midPrice) >= MIN_ORDER_VALUE) {
            const baseToSell = new Amount(sellBaseQty);
            promises.push(this.executor.executeMakerSell(pair, baseToSell, new Amount(ask), 1000));
        }

        if (promises.length > 0) {
            await Promise.all(promises);
            // After TTL, both will return their fills (which are logged internally).
            // The index.ts loop can then run the next tick.
        }
    }
}
