import { OrderExecutor, ActiveOrder } from "../domain/interfaces/OrderExecutor";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "./database/ErrorLogRepository";
import { TransactionRepository, TransactionLogEntry, LogId, Timestamp, TradeId, AssetName, MonetaryValue, TradeStatus } from "./database/TransactionRepository";
import { BinancePrecisionFetcher } from "./BinancePrecisionFetcher";
import { StateManager } from "../domain/interfaces/StateManager";
import * as crypto from "crypto";

/**
 * SimulationOrderExecutor mimics BinanceOrderExecutor's full behavior:
 *   - Same retry logic (maxRetries = 3)
 *   - Random TTL wait simulating time-on-book
 *   - Probabilistic partial/full/no fills using orderbook depth
 *   - Same precision rounding via BinancePrecisionFetcher
 *   - Same fallback flow (retry on partial, accumulate fills)
 *   - Logs trades to TransactionRepository and errors to ErrorLogRepository
 *   - Updates a virtual balance ledger instead of hitting Binance API
 */
export class SimulationOrderExecutor implements OrderExecutor {
    // Virtual balances managed internally
    private _baseBalance: number = 0;
    private _quoteBalance: number = 0;
    // Fee simulation: Binance charges 0.1% maker fee (or 0% for FDUSD)
    private readonly BASE_FEE_RATE = 0.001;   // 0.1%
    public totalFeesCollected: number = 0;     // Track total fees for telemetry

    constructor(
        private readonly errorLogger: ErrorLogRepository,
        private readonly transactionRepo: TransactionRepository,
        private readonly precisionFetcher: BinancePrecisionFetcher,
        private readonly stateManager: StateManager
    ) {}

    // --- Public getters for balance access from index.ts ---
    public get baseBalance(): number { return this._baseBalance; }
    public get quoteBalance(): number { return this._quoteBalance; }

    // --- Initialize virtual balances (called when switching to SIM mode) ---
    public setInitialBalances(base: number, quote: number): void {
        this._baseBalance = base;
        this._quoteBalance = quote;
        console.log(`🧪 [SIM] Balances initialized: Base=${base}, Quote=${quote}`);
    }

    public canExecuteBatch(count: number): boolean {
        // In simulation, we never hit rate limits
        return true;
    }

    public logError(type: string, message: string): void {
        console.error(`[SIM ERROR] ${type}: ${message}`);
        const entry = new ErrorLogEntry(
            { asString: () => crypto.randomUUID() } as any,
            { asNumber: () => Date.now() } as any,
            new ErrorType(type),
            new ErrorMessage(message),
            new StackTrace(null),
            new ErrorContext("{}")
        );
        this.errorLogger.save(entry);
    }

        private activeOrders = new Map<string, { order: ActiveOrder, pair: Pair, amountVal: number, truncatedQty: number }>();

    public async executeMakerBuy(pair: Pair, amount: Amount, price?: Amount): Promise<ActiveOrder | null> {
        return this.simulateOrder("BUY", pair, amount, price);
    }

    public async executeMakerSell(pair: Pair, amount: Amount, price?: Amount): Promise<ActiveOrder | null> {
        return this.simulateOrder("SELL", pair, amount, price);
    }

    public async cancelOrder(order: ActiveOrder): Promise<OrderFill> {
        const simData = this.activeOrders.get(order.orderId);
        if (!simData) return OrderFill.failed();
        this.activeOrders.delete(order.orderId);

        // Simulate TTL wait
        const ttlMs = 1500;
        const simWait = ttlMs * (0.1 + Math.random() * 0.9);
        await new Promise(r => setTimeout(r, simWait));

        const fillRoll = Math.random();
        let fillRatio = 0;
        if (fillRoll < 0.75) {
            fillRatio = 0;
        } else if (fillRoll < 0.90) {
            fillRatio = 0.1 + Math.random() * 0.8;
        } else {
            fillRatio = 1.0;
        }

        const quantityDecimals = this.precisionFetcher.getQuantityDecimals(order.symbol);
        const factor = Math.pow(10, quantityDecimals);
        const filledQty = Math.floor(simData.truncatedQty * fillRatio * factor) / factor;

        if (filledQty <= 0) return OrderFill.failed();

        const filledQuote = filledQty * order.price;

        let isFdusd = false;
        let baseSym = "";
        simData.pair.applyCurrencies((b, q) => {
           b.applySymbol(s => baseSym = s.toUpperCase());
           q.applySymbol(s => isFdusd = s.toUpperCase() === "FDUSD");
        });
        const zeroFeePromoBases = ['BTC', 'BNB', 'DOGE', 'ETH', 'LINK', 'SOL', 'XRP'];
        const isZeroFeePromo = isFdusd && zeroFeePromoBases.includes(baseSym);
        const feeRate = isZeroFeePromo ? 0 : this.BASE_FEE_RATE;

        let feeInQuote = 0;
        if (order.side === "BUY") {
            this._quoteBalance -= filledQuote;
            const feeBase = filledQty * feeRate;
            this._baseBalance += (filledQty - feeBase);
            feeInQuote = feeBase * order.price;
        } else {
            this._baseBalance -= filledQty;
            const feeQuote = filledQuote * feeRate;
            this._quoteBalance += (filledQuote - feeQuote);
            feeInQuote = feeQuote;
        }

        this.totalFeesCollected += feeInQuote;

        const executedQtyAmt = new Amount(filledQty);
        const cummulativeQuoteQtyAmt = new Amount(filledQuote);
        const averagePriceAmt = new Amount(order.price);

        this.logTrade(order.symbol, executedQtyAmt, averagePriceAmt, "SIM_LIMIT_MAKER");
        return new OrderFill(executedQtyAmt, cummulativeQuoteQtyAmt, averagePriceAmt, true);
    }

    public async cancelAllOrders(pair: Pair): Promise<void> {
        let symbol = "";
        pair.applyBinanceSymbol((sym) => { symbol = sym; });

        this.activeOrders.forEach((o, id) => {
            if (o.order.symbol === symbol) {
                this.activeOrders.delete(id);
            }
        });
        console.log(`🧹 [SIM] Canceled all open orders for ${symbol}.`);
    }

    private async simulateOrder(side: "BUY"|"SELL", pair: Pair, amount: Amount, price: Amount | undefined): Promise<ActiveOrder | null> {
        let symbol = "";
        pair.applyBinanceSymbol((sym) => { symbol = sym; });

        let amountVal = 0;
        amount.apply((val) => { amountVal = val; });

        let targetPriceRaw = 0;
        if (price) {
            price.apply(v => targetPriceRaw = v);
        } else {
            const book = this.stateManager.retrieveOrderBook(pair);
            const tick = book.getLatest();
            if (!tick) return null;
            const midPriceAmount = tick.getMidPrice();
            if (!midPriceAmount) return null;
            midPriceAmount.apply(v => targetPriceRaw = v);
        }

        const tickSize = this.precisionFetcher.getPriceTickSize(symbol);
        const quantityDecimals = this.precisionFetcher.getQuantityDecimals(symbol);

        let roundedPrice = targetPriceRaw;
        if (side === "BUY") {
            roundedPrice = Math.floor(targetPriceRaw / tickSize) * tickSize;
        } else {
            roundedPrice = Math.ceil(targetPriceRaw / tickSize) * tickSize;
        }

        const factor = Math.pow(10, quantityDecimals);
        let baseQuantityRaw = 0;
        if (side === "BUY") {
            baseQuantityRaw = amountVal / roundedPrice;
        } else {
            baseQuantityRaw = amountVal;
        }

        const truncatedQty = Math.floor(baseQuantityRaw * factor) / factor;
        if (truncatedQty <= 0) return null;

        if (side === "BUY") {
            const costQuote = truncatedQty * roundedPrice;
            if (costQuote > this._quoteBalance) return null;
        } else {
            if (truncatedQty > this._baseBalance) return null;
        }

        const activeOrder: ActiveOrder = {
            orderId: crypto.randomUUID(),
            symbol,
            side,
            price: roundedPrice,
            qty: truncatedQty,
            timestamp: Date.now()
        };

        this.activeOrders.set(activeOrder.orderId, { order: activeOrder, pair, amountVal, truncatedQty });
        return activeOrder;
    }

private logError(type: string, message: string): void {
        console.error(`[SIM][${type}] ${message}`);
        const entry = new ErrorLogEntry(
            { asString: () => crypto.randomUUID() } as any,
            { asNumber: () => Date.now() } as any,
            new ErrorType(type),
            new ErrorMessage(message),
            new StackTrace(null),
            new ErrorContext("{}")
        );
        this.errorLogger.save(entry);
    }

    private logTrade(symbol: string, quantity: Amount, price: Amount, status: string): void {
        let rawQty = 0;
        let rawPrice = 0;
        quantity.apply((val) => rawQty = val);
        price.apply((val) => rawPrice = val);

        console.log(`🧪 [SIM] ${status} | ${symbol} | Qty: ${rawQty} | Price: ${rawPrice} | Base: ${this._baseBalance.toFixed(6)} | Quote: ${this._quoteBalance.toFixed(2)}`);

        const entry = new TransactionLogEntry(
            new LogId(crypto.randomUUID()),
            new Timestamp(Date.now()),
            new TradeId(crypto.randomUUID()),
            new AssetName(symbol),
            new MonetaryValue(rawQty),
            new MonetaryValue(rawPrice),
            new MonetaryValue(0),
            new TradeStatus(status)
        );
        this.transactionRepo.save(entry);
    }
}
