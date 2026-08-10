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

    // Reposicionar uma ordem custa prioridade de fila: a ordem nova volta para o fim
    // da fila. Cancelar de forma agressiva significa que a única maneira de ser
    // executado é o preço atravessar a ordem — ou seja, apenas quando estamos errados.
    // Estes três parâmetros seguem a semântica do Hummingbot (order_refresh_time,
    // max_order_age, order_refresh_tolerance_pct).
    private readonly ORDER_REFRESH_TIME_MS = 30000; // intervalo mínimo entre reposicionamentos
    private readonly MAX_ORDER_AGE_MS = 60000;      // idade máxima absoluta de uma ordem
    private readonly MIN_TOLERANCE_PCT = 0.0005;    // piso da tolerância de desvio de preço
    private lastRefreshAt = 0;

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

    public async executeTick(pair: Pair, feeRate: number = 0.001, volatilityPct: number = 0, isZeroFee: boolean = false, k: number = 1.5, minNotional: number = 10): Promise<void> {
        this.currentPair = pair;

        const levels = this.inventoryManager.ORDER_LEVELS;

        // Ensure arrays match InventoryManager levels
        while (this.activeBuyOrders.length < levels) this.activeBuyOrders.push(null);
        while (this.activeSellOrders.length < levels) this.activeSellOrders.push(null);

        // Se ORDER_LEVELS diminuiu em runtime, os níveis excedentes ficariam órfãos:
        // nunca mais seriam avaliados, mas seguiriam descontando saldo. Cancela e descarta.
        if (this.activeBuyOrders.length > levels || this.activeSellOrders.length > levels) {
            const orphans = [
                ...this.activeBuyOrders.slice(levels),
                ...this.activeSellOrders.slice(levels),
            ].filter((o): o is ActiveOrder => o !== null);
            this.activeBuyOrders.length = levels;
            this.activeSellOrders.length = levels;
            await Promise.all(orphans.map(o => this.executor.cancelOrder(o).catch(() => {})));
        }

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

        let { bids, asks, bidEnabled, askEnabled, q, effectiveSpread } = this.inventoryManager.getQuotes(midPrice, feeRate, volatilityPct, isZeroFee, bestBid, bestAsk, k);

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
        const MIN_ORDER_VALUE = minNotional;

        if (MAX_ORDER_VALUE < MIN_ORDER_VALUE) {
            this.logStuck(`CAPITAL INSUFICIENTE: patrimônio ${totalWealth.toFixed(2)} permite no máximo ${MAX_ORDER_VALUE.toFixed(2)} por ordem, mas o mínimo da exchange é ${MIN_ORDER_VALUE.toFixed(2)}. Nenhuma cotação é possível.`);
            return;
        }

        let baseLotQuote = this.lotConfig.mode === "PERCENTAGE"
            ? totalWealth * this.lotConfig.value
            : this.lotConfig.value;

        // O skew de estoque é aplicado ANTES do piso de notional mínimo.
        // A ordem inversa (piso antes do skew) fazia o skew empurrar o lote de volta
        // para baixo do mínimo, bloqueando o nível — e como o skew só encolhe o lado
        // comprador quando estamos long, o lado da compra morria em silêncio enquanto
        // o da venda seguia ativo, produzindo deriva estrutural de estoque.
        let buyLotQuote = baseLotQuote * Math.max(0.2, 1 - q * 1.5);
        let sellLotQuote = baseLotQuote * Math.max(0.2, 1 + q * 1.5);

        // O notional mínimo é uma restrição rígida da corretora, não uma preferência de
        // risco: se o skew pedir menos que o mínimo, postamos o mínimo para manter os
        // dois lados cotados. O corte de risco de verdade continua sendo o
        // bidEnabled/askEnabled do InventoryManager (MAX_INVENTORY_SKEW).
        buyLotQuote = Math.min(Math.max(buyLotQuote, MIN_ORDER_VALUE), MAX_ORDER_VALUE);
        sellLotQuote = Math.min(Math.max(sellLotQuote, MIN_ORDER_VALUE), MAX_ORDER_VALUE);

        this.currentEffectiveBuyLotQuote = buyLotQuote;
        this.currentEffectiveSellLotQuote = sellLotQuote;

        // --- Decisão de reposicionamento (semântica do Hummingbot) ---
        // Só cancelamos quando alguma ordem estourou a idade máxima, ou quando o preço
        // saiu da tolerância E já passou o intervalo mínimo de refresh. Fora disso as
        // ordens ficam paradas acumulando prioridade de fila.
        const now = TimeProvider.now();
        const tolerancePct = Math.max(this.MIN_TOLERANCE_PCT, effectiveSpread * 0.5);

        let priceDrifted = false;
        let ageExceeded = false;
        for (let i = 0; i < levels; i++) {
            const b = this.activeBuyOrders[i];
            if (b) {
                if (Math.abs(b.price - bids[i]!.price) / bids[i]!.price > tolerancePct) priceDrifted = true;
                if (now - b.timestamp > this.MAX_ORDER_AGE_MS) ageExceeded = true;
            }
            const s = this.activeSellOrders[i];
            if (s) {
                if (Math.abs(s.price - asks[i]!.price) / asks[i]!.price > tolerancePct) priceDrifted = true;
                if (now - s.timestamp > this.MAX_ORDER_AGE_MS) ageExceeded = true;
            }
        }

        const refreshWindowOpen = now - this.lastRefreshAt >= this.ORDER_REFRESH_TIME_MS;
        if (ageExceeded || (priceDrifted && refreshWindowOpen)) {
            this.lastRefreshAt = now;
            const cancels: Promise<unknown>[] = [];
            for (let i = 0; i < levels; i++) {
                const b = this.activeBuyOrders[i];
                if (b) { cancels.push(this.executor.cancelOrder(b)); this.activeBuyOrders[i] = null; }
                const s = this.activeSellOrders[i];
                if (s) { cancels.push(this.executor.cancelOrder(s)); this.activeSellOrders[i] = null; }
            }
            // Em paralelo: serializados, 2×ORDER_LEVELS round-trips cabiam mal no ciclo.
            await Promise.all(cancels);
        }

        const promises: Promise<void>[] = [];

        for (let i = 0; i < levels; i++) {
            const targetBid = bids[i]!.price;
            const targetAsk = asks[i]!.price;
            const buyLevelQuote = buyLotQuote * bids[i]!.amountFactor;
            const sellLevelBase = (sellLotQuote * asks[i]!.amountFactor) / midPrice;

            // Cancelamentos já foram resolvidos em bloco acima; aqui só preenchemos
            // os níveis vazios (ordem executada, cancelada ou ainda não colocada).
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
