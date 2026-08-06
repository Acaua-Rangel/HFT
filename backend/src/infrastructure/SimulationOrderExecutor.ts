import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
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

    public async executeMakerBuy(pair: Pair, amount: Amount, price?: Amount, ttlMs = 2500): Promise<OrderFill> {
        return this.simulateOrder("BUY", pair, amount, price, ttlMs);
    }

    public async executeMakerSell(pair: Pair, amount: Amount, price?: Amount, ttlMs = 2500): Promise<OrderFill> {
        return this.simulateOrder("SELL", pair, amount, price, ttlMs);
    }



    // ================================================================
    // Core simulation: mirrors sendWsOrder from BinanceOrderExecutor
    // ================================================================
    private async simulateOrder(side: string, pair: Pair, amount: Amount, price: Amount | undefined, ttlMs: number): Promise<OrderFill> {
        let symbol = "";
        pair.applyBinanceSymbol((sym) => { symbol = sym; });

        let amountVal = 0;
        amount.apply((val) => { amountVal = val; });

        const maxRetries = 3;
        let accumulatedExecutedQty = 0;
        let accumulatedQuoteQty = 0;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                // ---- Step 1: Determine target price (same logic as real executor) ----
                let targetPriceRaw = 0;
                if (price) {
                    price.apply(v => targetPriceRaw = v);
                } else {
                    const book = this.stateManager.retrieveOrderBook(pair);
                    const tick = book.getLatest();
                    if (!tick) break;
                    const midPriceAmount = tick.getMidPrice();
                    if (!midPriceAmount) break;
                    midPriceAmount.apply(v => targetPriceRaw = v);
                }

                // ---- Step 2: Round price using real precision data ----
                const tickSize = this.precisionFetcher.getPriceTickSize(symbol);
                const quantityDecimals = this.precisionFetcher.getQuantityDecimals(symbol);

                let roundedPrice = targetPriceRaw;
                if (side === "BUY") {
                    roundedPrice = Math.floor(targetPriceRaw / tickSize) * tickSize;
                } else {
                    roundedPrice = Math.ceil(targetPriceRaw / tickSize) * tickSize;
                }

                const factor = Math.pow(10, quantityDecimals);

                // ---- Step 3: Calculate quantity (same logic as real executor) ----
                let baseQuantityRaw = 0;
                if (side === "BUY") {
                    const remainingQuote = amountVal - accumulatedQuoteQty;
                    if (remainingQuote <= 0) break;
                    baseQuantityRaw = remainingQuote / roundedPrice;
                } else {
                    const remainingBase = amountVal - accumulatedExecutedQty;
                    if (remainingBase <= 0) break;
                    baseQuantityRaw = remainingBase;
                }

                const truncatedQty = Math.floor(baseQuantityRaw * factor) / factor;
                if (truncatedQty <= 0) break;

                // ---- Step 4: Check if we have sufficient virtual balance ----
                if (side === "BUY") {
                    const costQuote = truncatedQty * roundedPrice;
                    if (costQuote > this._quoteBalance) {
                        // Not enough quote balance - simulate a rejection like -2010
                        if (attempt < maxRetries - 1) continue;
                        break;
                    }
                } else {
                    if (truncatedQty > this._baseBalance) {
                        if (attempt < maxRetries - 1) continue;
                        break;
                    }
                }

                // ---- Step 5: Simulate TTL wait ----
                // Em HFT real, ordens passivas (Maker) que são executadas geralmente sofrem execução
                // logo no início (seleção adversa) ou perto do fim do TTL (quando chegam no topo da fila).
                const simWait = ttlMs * (0.1 + Math.random() * 0.9);
                await new Promise(r => setTimeout(r, simWait));

                // ---- Step 6: Probabilistic fill simulation ----
                // Mundo real HFT Maker: a taxa de preenchimento completo é muito baixa (ex: 5-10%).
                // A maioria das ordens é cancelada sem preenchimento porque o mercado se move.
                const fillRoll = Math.random();
                let fillRatio: number;

                if (fillRoll < 0.75) {
                    // No fill (75%) - mercado se moveu contra, ou cancelada antes de preencher
                    fillRatio = 0;
                } else if (fillRoll < 0.90) {
                    // Partial fill (15%) - beliscaram a ordem mas n levaram tudo
                    fillRatio = 0.1 + Math.random() * 0.8;
                } else {
                    // Full fill (10%)
                    fillRatio = 1.0;
                }

                const filledQty = Math.floor(truncatedQty * fillRatio * factor) / factor;

                if (filledQty <= 0) {
                    // Simulates the "order cancelled with 0 fill" path
                    // On retry, the real executor would re-post
                    continue;
                }

                const filledQuote = filledQty * roundedPrice;

                // ---- Step 7: Apply trading fee ----
                let isFdusd = false;
                let baseSym = "";
                pair.applyCurrencies((b, q) => {
                   b.applySymbol(s => baseSym = s.toUpperCase());
                   q.applySymbol(s => isFdusd = s.toUpperCase() === "FDUSD");
                });
                const zeroFeePromoBases = ['BTC', 'BNB', 'DOGE', 'ETH', 'LINK', 'SOL', 'XRP'];
                const isZeroFeePromo = isFdusd && zeroFeePromoBases.includes(baseSym);
                const feeRate = isZeroFeePromo ? 0 : this.BASE_FEE_RATE;

                let feeInQuote = 0;
                
                // Binance deducts fee from the RECEIVED asset
                if (side === "BUY") {
                    this._quoteBalance -= filledQuote;
                    const feeBase = filledQty * feeRate;
                    this._baseBalance += (filledQty - feeBase);
                    feeInQuote = feeBase * roundedPrice;
                } else {
                    this._baseBalance -= filledQty;
                    const feeQuote = filledQuote * feeRate;
                    this._quoteBalance += (filledQuote - feeQuote);
                    feeInQuote = feeQuote;
                }

                this.totalFeesCollected += feeInQuote;

                accumulatedExecutedQty += filledQty;
                accumulatedQuoteQty += filledQuote;

                // Check if fully filled
                if (fillRatio >= 1.0) break;

                // Check 99% threshold (same as real executor)
                if (side === "BUY" && accumulatedQuoteQty >= amountVal * 0.99) break;
                if (side === "SELL" && accumulatedExecutedQty >= amountVal * 0.99) break;

                // Otherwise, retry with remaining amount (partial fill fallback)
            } catch (err) {
                this.logError("SIM_ORDER_EXCEPTION", err instanceof Error ? err.message : String(err));
                break;
            }
        }

        if (accumulatedExecutedQty === 0) {
            return OrderFill.failed();
        }

        const executedQtyAmt = new Amount(accumulatedExecutedQty);
        const cummulativeQuoteQtyAmt = new Amount(accumulatedQuoteQty);

        let averagePriceVal = 0;
        if (accumulatedExecutedQty > 0) {
            averagePriceVal = accumulatedQuoteQty / accumulatedExecutedQty;
        }
        const averagePriceAmt = new Amount(averagePriceVal);

        this.logTrade(symbol, executedQtyAmt, averagePriceAmt, "SIM_LIMIT_MAKER");
        return new OrderFill(executedQtyAmt, cummulativeQuoteQtyAmt, averagePriceAmt, true);
    }



    // ================================================================
    // Logging (identical signatures to BinanceOrderExecutor)
    // ================================================================
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
