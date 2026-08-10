import { Pair } from "../../domain/valueObjects/Pair";
import { OrderExecutor, ActiveOrder } from "../../domain/interfaces/OrderExecutor";
import { Amount } from "../../domain/valueObjects/Amount";
import { LocalStateManager } from "../LocalStateManager";
import { CircuitBreaker } from "./CircuitBreaker";
import { InventoryManager } from "./InventoryManager";

export class MarketMakerCycle {
    public lotConfig: { mode: "PERCENTAGE" | "FIXED", value: number } = { mode: "PERCENTAGE", value: 0.05 };
    
    public currentEffectiveBuyLotQuote: number = 0;
    public currentEffectiveSellLotQuote: number = 0;

    public activeBuyOrder: ActiveOrder | null = null;
    public activeSellOrder: ActiveOrder | null = null;

    private readonly TOLERANCE_PCT = 0.0005; // 0.05% price deviation tolerance
    private readonly MAX_ORDER_AGE_MS = 10000; // 10 seconds

    constructor(
        private stateManager: LocalStateManager,
        private circuitBreaker: CircuitBreaker,
        private inventoryManager: InventoryManager,
        public executor: OrderExecutor
    ) {}

    private async checkAndCancelOrder(
        order: ActiveOrder | null, 
        newTargetPrice: number
    ): Promise<ActiveOrder | null> {
        if (!order) return null;
        
        const priceDeviation = Math.abs(order.price - newTargetPrice) / newTargetPrice;
        const age = Date.now() - order.timestamp;
        
        if (priceDeviation > this.TOLERANCE_PCT || age > this.MAX_ORDER_AGE_MS) {
            await this.executor.cancelOrder(order);
            return null; // Cleared
        }
        return order; // Keep active
    }

    public async executeTick(pair: Pair, feeRate: number = 0.001, volatilityPct: number = 0, isZeroFee: boolean = false): Promise<void> {
        if (this.circuitBreaker.shouldPause(pair)) {
            // Cancel all active orders if circuit breaker triggers
            if (this.activeBuyOrder) {
                await this.executor.cancelOrder(this.activeBuyOrder);
                this.activeBuyOrder = null;
            }
            if (this.activeSellOrder) {
                await this.executor.cancelOrder(this.activeSellOrder);
                this.activeSellOrder = null;
            }
            return;
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
        if (bestAsk > 0 && bid >= bestAsk) {
            bid = bestAsk * 0.99999;
        }
        if (bestBid > 0 && ask <= bestBid) {
            ask = bestBid * 1.00001;
        }

        const totalWealth = (this.inventoryManager.baseBalance * midPrice) + this.inventoryManager.quoteBalance;
        const MAX_ORDER_VALUE = totalWealth * 0.60;

        let baseLotQuote = this.lotConfig.mode === "PERCENTAGE" 
            ? totalWealth * this.lotConfig.value 
            : this.lotConfig.value;

        const MIN_ORDER_VALUE = 10;
        baseLotQuote = Math.max(baseLotQuote, MIN_ORDER_VALUE);
        baseLotQuote = Math.min(baseLotQuote, MAX_ORDER_VALUE);

        let buyLotQuote = baseLotQuote * Math.max(0.2, 1 - q * 1.5);
        let sellLotQuote = baseLotQuote * Math.max(0.2, 1 + q * 1.5);

        buyLotQuote = Math.min(buyLotQuote, this.inventoryManager.quoteBalance);
        let sellBaseQty = sellLotQuote / midPrice;
        sellBaseQty = Math.min(sellBaseQty, this.inventoryManager.baseBalance);

        this.currentEffectiveBuyLotQuote = buyLotQuote;
        this.currentEffectiveSellLotQuote = sellLotQuote;

        // Active Order Tracking & Cancellation
        this.activeBuyOrder = await this.checkAndCancelOrder(this.activeBuyOrder, bid);
        this.activeSellOrder = await this.checkAndCancelOrder(this.activeSellOrder, ask);
        
        const promises: Promise<void>[] = [];

        if (!this.activeBuyOrder && bidEnabled && bid > 0 && buyLotQuote >= MIN_ORDER_VALUE) {
            const quoteToSpend = new Amount(buyLotQuote); 
            promises.push(
                this.executor.executeMakerBuy(pair, quoteToSpend, new Amount(bid))
                .then(order => { if (order) this.activeBuyOrder = order; })
            );
        }

        if (!this.activeSellOrder && askEnabled && ask > 0 && (sellBaseQty * midPrice) >= MIN_ORDER_VALUE) {
            const baseToSell = new Amount(sellBaseQty);
            promises.push(
                this.executor.executeMakerSell(pair, baseToSell, new Amount(ask))
                .then(order => { if (order) this.activeSellOrder = order; })
            );
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }
}
