import { Pair } from "../../domain/valueObjects/Pair";
import { OrderExecutor, ActiveOrder } from "../../domain/interfaces/OrderExecutor";
import { Amount } from "../../domain/valueObjects/Amount";
import { LocalStateManager } from "../LocalStateManager";
import { CircuitBreaker } from "./CircuitBreaker";
import { InventoryManager } from "./InventoryManager";
import { BinanceUserDataStream, ExecutionReport } from "../../infrastructure/BinanceUserDataStream";
import { TimeProvider } from "../../infrastructure/TimeProvider";

export class MarketMakerCycle {
    public lotConfig: { mode: "PERCENTAGE" | "FIXED", value: number } = { mode: "PERCENTAGE", value: 0.05 };
    
    public currentEffectiveBuyLotQuote: number = 0;
    public currentEffectiveSellLotQuote: number = 0;

    public activeBuyOrders: (ActiveOrder | null)[] = [];
    public activeSellOrders: (ActiveOrder | null)[] = [];
    
    public hangingBuyOrders: ActiveOrder[] = [];
    public hangingSellOrders: ActiveOrder[] = [];

    private readonly TOLERANCE_PCT = 0.0005; // 0.05% price deviation tolerance
    private readonly MAX_ORDER_AGE_MS = 3000; // 3 seconds
    private readonly PING_PONG_SPREAD = 0.001; // 0.1% minimum profit for ping-pong
    
    public currentPair: Pair | null = null;

    constructor(
        private stateManager: LocalStateManager,
        private circuitBreaker: CircuitBreaker,
        private inventoryManager: InventoryManager,
        public executor: OrderExecutor,
        private userDataStream?: BinanceUserDataStream
    ) {
        if (this.userDataStream) {
            this.userDataStream.onOrderFilled(this.handleOrderFilled.bind(this));
            this.userDataStream.onOrderCanceled(this.handleOrderCanceled.bind(this));
        }
    }

    private async handleOrderFilled(report: ExecutionReport): Promise<void> {
        let isBuy = true;
        let isHanging = false;

        // Clean from active arrays
        for (let i = 0; i < this.activeBuyOrders.length; i++) {
            if (this.activeBuyOrders[i]?.orderId === report.clientOrderId || this.activeBuyOrders[i]?.orderId === report.orderId.toString()) {
                this.activeBuyOrders[i] = null;
                isBuy = true;
                isHanging = false;
            }
        }
        for (let i = 0; i < this.activeSellOrders.length; i++) {
            if (this.activeSellOrders[i]?.orderId === report.clientOrderId || this.activeSellOrders[i]?.orderId === report.orderId.toString()) {
                this.activeSellOrders[i] = null;
                isBuy = false;
                isHanging = false;
            }
        }

        // Clean from hanging arrays
        const hbIndex = this.hangingBuyOrders.findIndex(o => o.orderId === report.clientOrderId || o.orderId === report.orderId.toString());
        if (hbIndex >= 0) {
            this.hangingBuyOrders.splice(hbIndex, 1);
            isBuy = true;
            isHanging = true;
        }
        const hsIndex = this.hangingSellOrders.findIndex(o => o.orderId === report.clientOrderId || o.orderId === report.orderId.toString());
        if (hsIndex >= 0) {
            this.hangingSellOrders.splice(hsIndex, 1);
            isBuy = false;
            isHanging = true;
        }

        if (report.orderStatus === "FILLED" && this.currentPair) {
            const filledPrice = report.lastFilledPrice || report.originalPrice;
            const totalQty = report.accumulatedFilledQty || report.originalQty;
            
            // Generate Ping-Pong Hanging Order
            if (isBuy) {
                // Bought, so we sell higher
                const targetAsk = filledPrice * (1 + this.PING_PONG_SPREAD);
                this.executor.executeMakerSell(this.currentPair, new Amount(totalQty), new Amount(targetAsk))
                    .then(order => { if (order) this.hangingSellOrders.push(order); });
            } else {
                // Sold, so we buy lower
                const targetBid = filledPrice * (1 - this.PING_PONG_SPREAD);
                const quoteSpend = totalQty * targetBid;
                this.executor.executeMakerBuy(this.currentPair, new Amount(quoteSpend), new Amount(targetBid))
                    .then(order => { if (order) this.hangingBuyOrders.push(order); });
            }
        }
    }

    private async handleOrderCanceled(report: ExecutionReport): Promise<void> {
        for (let i = 0; i < this.activeBuyOrders.length; i++) {
            if (this.activeBuyOrders[i]?.orderId === report.clientOrderId || this.activeBuyOrders[i]?.orderId === report.orderId.toString()) {
                this.activeBuyOrders[i] = null;
            }
        }
        for (let i = 0; i < this.activeSellOrders.length; i++) {
            if (this.activeSellOrders[i]?.orderId === report.clientOrderId || this.activeSellOrders[i]?.orderId === report.orderId.toString()) {
                this.activeSellOrders[i] = null;
            }
        }
        this.hangingBuyOrders = this.hangingBuyOrders.filter(o => o.orderId !== report.clientOrderId && o.orderId !== report.orderId.toString());
        this.hangingSellOrders = this.hangingSellOrders.filter(o => o.orderId !== report.clientOrderId && o.orderId !== report.orderId.toString());
    }

    private async checkAndCancelOrder(
        order: ActiveOrder | null, 
        newTargetPrice: number
    ): Promise<boolean> {
        if (!order) return true; // Already clear
        
        const priceDeviation = Math.abs(order.price - newTargetPrice) / newTargetPrice;
        const age = TimeProvider.now() - order.timestamp;
        
        if (priceDeviation > this.TOLERANCE_PCT || age > this.MAX_ORDER_AGE_MS) {
            await this.executor.cancelOrder(order);
            return true; // Cleared
        }
        return false; // Keep active
    }

    public async executeTick(pair: Pair, feeRate: number = 0.001, volatilityPct: number = 0, isZeroFee: boolean = false, k: number = 1.5): Promise<void> {
        this.currentPair = pair;
        
        // Ensure arrays match InventoryManager levels
        while (this.activeBuyOrders.length < this.inventoryManager.ORDER_LEVELS) this.activeBuyOrders.push(null);
        while (this.activeSellOrders.length < this.inventoryManager.ORDER_LEVELS) this.activeSellOrders.push(null);

        if (this.circuitBreaker.shouldPause(pair)) {
            // Cancel all active orders if circuit breaker triggers (Hanging orders are optionally kept, but we'll cancel them for safety)
            for (let i = 0; i < this.activeBuyOrders.length; i++) {
                if (this.activeBuyOrders[i]) { await this.executor.cancelOrder(this.activeBuyOrders[i]!); this.activeBuyOrders[i] = null; }
            }
            for (let i = 0; i < this.activeSellOrders.length; i++) {
                if (this.activeSellOrders[i]) { await this.executor.cancelOrder(this.activeSellOrders[i]!); this.activeSellOrders[i] = null; }
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

        let { bids, asks, bidEnabled, askEnabled, q } = this.inventoryManager.getQuotes(midPrice, feeRate, volatilityPct, isZeroFee, bestBid, bestAsk, k);

        // Enforce Post-Only limits for the tightest level (Level 0)
        // If the tightest level crosses, we adjust all levels relative to it
        if (bids.length > 0 && bestAsk > 0 && bids[0]!.price >= bestAsk) {
            const shift = bids[0]!.price - (bestAsk * 0.99999);
            bids.forEach(b => b.price -= shift);
        }
        if (asks.length > 0 && bestBid > 0 && asks[0]!.price <= bestBid) {
            const shift = (bestAsk * 1.00001) - asks[0]!.price; // Wait, this should be bestBid * 1.00001
            // Let's fix this inline below: asks.forEach(a => a.price += shift);
        }

        if (asks.length > 0 && bestBid > 0 && asks[0]!.price <= bestBid) {
            const shift = (bestBid * 1.00001) - asks[0]!.price;
            asks.forEach(a => a.price += shift);
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

        this.currentEffectiveBuyLotQuote = buyLotQuote;
        this.currentEffectiveSellLotQuote = sellLotQuote;

        const promises: Promise<void>[] = [];

        for (let i = 0; i < this.inventoryManager.ORDER_LEVELS; i++) {
            const targetBid = bids[i]!.price;
            const targetAsk = asks[i]!.price;
            const buyLevelQuote = buyLotQuote * bids[i]!.amountFactor;
            const sellLevelBase = (sellLotQuote * asks[i]!.amountFactor) / midPrice;

            // Active Order Tracking & Cancellation per level
            const buyCleared = await this.checkAndCancelOrder(this.activeBuyOrders[i] ?? null, targetBid);
            if (buyCleared) this.activeBuyOrders[i] = null;
            
            const sellCleared = await this.checkAndCancelOrder(this.activeSellOrders[i] ?? null, targetAsk);
            if (sellCleared) this.activeSellOrders[i] = null;
            
            // Place new orders if empty
            let lockedQuote = 0;
            for (const o of this.activeBuyOrders) {
                if (o) lockedQuote += (o.qty * o.price);
            }
            for (const o of this.hangingBuyOrders) {
                if (o) lockedQuote += (o.qty * o.price);
            }
            
            let lockedBase = 0;
            for (const o of this.activeSellOrders) {
                if (o) lockedBase += o.qty;
            }
            for (const o of this.hangingSellOrders) {
                if (o) lockedBase += o.qty;
            }

            if (!this.activeBuyOrders[i] && bidEnabled && targetBid > 0) {
                let finalBuyLevelQuote = buyLevelQuote;
                if (buyLevelQuote + lockedQuote > this.inventoryManager.quoteBalance) {
                    finalBuyLevelQuote = this.inventoryManager.quoteBalance - lockedQuote;
                }
                
                const meetsMin = finalBuyLevelQuote >= MIN_ORDER_VALUE;
                
                if (meetsMin) {
                    const quoteToSpend = new Amount(finalBuyLevelQuote); 
                    this.activeBuyOrders[i] = { orderId: "-1", symbol: "", side: "BUY", price: targetBid, qty: finalBuyLevelQuote / targetBid, timestamp: TimeProvider.now() }; // Optimistic lock
                    promises.push(
                        this.executor.executeMakerBuy(pair, quoteToSpend, new Amount(targetBid))
                        .then(order => { 
                            if (order) this.activeBuyOrders[i] = order; 
                            else this.activeBuyOrders[i] = null;
                        })
                    );
                } else if (i === 0 && finalBuyLevelQuote < MIN_ORDER_VALUE) {
                    this.logStuck(`BUY L${i} BLOCKED: Insufficient Balance. Required: ${MIN_ORDER_VALUE.toFixed(2)} | Free(Available): ${finalBuyLevelQuote.toFixed(2)}`);
                }
            }

            if (!this.activeSellOrders[i] && askEnabled && targetAsk > 0) {
                let finalSellLevelBase = sellLevelBase;
                if (sellLevelBase + lockedBase > this.inventoryManager.baseBalance) {
                    finalSellLevelBase = this.inventoryManager.baseBalance - lockedBase;
                }
                
                const meetsMin = (finalSellLevelBase * midPrice) >= MIN_ORDER_VALUE;
                
                if (meetsMin) {
                    const baseToSell = new Amount(finalSellLevelBase);
                    this.activeSellOrders[i] = { orderId: "-1", symbol: "", side: "SELL", price: targetAsk, qty: finalSellLevelBase, timestamp: TimeProvider.now() }; // Optimistic lock
                    promises.push(
                        this.executor.executeMakerSell(pair, baseToSell, new Amount(targetAsk))
                        .then(order => { 
                            if (order) this.activeSellOrders[i] = order; 
                            else this.activeSellOrders[i] = null;
                        })
                    );
                } else if (i === 0 && !meetsMin) {
                    this.logStuck(`SELL L${i} BLOCKED: Insufficient Balance. Required: ${MIN_ORDER_VALUE.toFixed(2)} | Free(Available): ${(finalSellLevelBase * midPrice).toFixed(2)}`);
                }
            }
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    private lastStuckLog = 0;
    private logStuck(message: string) {
        const now = TimeProvider.now();
        if (now - this.lastStuckLog > 60000) { // Log once per minute max
            console.log(`\n🛑 [DIAGNOSTIC] ${message}`);
            
            // Also log to the error_logs table so it shows up in diagnostic scripts
            try {
                this.executor.logError("DIAGNOSTIC_STUCK", message);
            } catch (err) {}
            
            this.lastStuckLog = now;
        }
    }
}
