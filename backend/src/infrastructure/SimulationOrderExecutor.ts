import { OrderExecutor, ActiveOrder } from "../domain/interfaces/OrderExecutor";
import { BinanceUserDataStream, ExecutionReport } from "./BinanceUserDataStream";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "./database/ErrorLogRepository";
import { TransactionRepository, TransactionLogEntry, LogId, Timestamp, TradeId, AssetName, MonetaryValue, TradeStatus } from "./database/TransactionRepository";
import { BinancePrecisionFetcher } from "./BinancePrecisionFetcher";
import { StateManager } from "../domain/interfaces/StateManager";
import * as crypto from "crypto";
import { TimeProvider } from "./TimeProvider";

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

    /**
     * Notional (na moeda quote) que assumimos estar descansando à nossa frente na fila do
     * nível em que colocamos a ordem. Calibrar contra a profundidade real do book do par:
     * para BTCFDUSD medimos algumas centenas de FDUSD por nível no topo.
     */
    public queueAheadQuote: number = 500;

    constructor(
        private readonly errorLogger: ErrorLogRepository,
        private readonly transactionRepo: TransactionRepository,
        private readonly precisionFetcher: BinancePrecisionFetcher,
        private readonly stateManager: StateManager
    ) {}

    private userDataStream?: BinanceUserDataStream;
    public setUserDataStream(uds: BinanceUserDataStream): void {
        this.userDataStream = uds;
    }

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
            { asNumber: () => TimeProvider.now() } as any,
            new ErrorType(type),
            new ErrorMessage(message),
            new StackTrace(null),
            new ErrorContext("{}")
        );
        this.errorLogger.save(entry);
    }

    private activeOrders = new Map<string, { order: ActiveOrder, pair: Pair, amountVal: number, truncatedQty: number, queuePosition: number }>();

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
        if (!TimeProvider.isVirtual()) {
            await new Promise(r => setTimeout(r, simWait));
        }

        // Return failed since the order was explicitly canceled before being filled
        return OrderFill.failed();
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

    /**
     * Avalia execuções contra uma barra do histórico.
     *
     * @param barLow  mínima da barra; se ausente, cai para bestBid (modelo antigo, pior)
     * @param barHigh máxima da barra
     * @param tickVolume volume da barra em unidades do ativo BASE
     *
     * Duas correções sobre o modelo anterior, ambas motivadas pela medição do book real:
     *
     * 1. **Varredura intrabar.** Antes só o close era considerado, então uma barra que
     *    negociou abaixo do nosso bid e voltou não gerava execução. Agora a mínima/máxima
     *    da barra decide se o preço realmente atravessou nosso preço.
     *
     * 2. **Fila.** Antes a fila drenava a 15% do volume total da barra sempre que o preço
     *    "tocava", sem distinguir de que lado veio o fluxo nem a que distância do topo
     *    estávamos. Agora só drena quando estamos no topo, e apenas com a fração do fluxo
     *    que bate no nosso lado.
     */
    public evaluateFills(
        bestBid: number,
        bestAsk: number,
        tickVolume: number = 0,
        barLow?: number,
        barHigh?: number
    ): void {
        const toDelete: string[] = [];

        // Metade do fluxo agride o nosso lado do book (vendas batem em bids, compras em
        // asks). O 0.15 anterior era arbitrário e aplicado sobre o volume total.
        const SIDE_SHARE = 0.5;

        const low = barLow !== undefined && barLow > 0 ? barLow : bestBid;
        const high = barHigh !== undefined && barHigh > 0 ? barHigh : bestAsk;

        for (const [orderId, simData] of this.activeOrders.entries()) {
            const { order, pair, truncatedQty } = simData;

            let filled = false;
            const orderAge = TimeProvider.now() - order.timestamp;

            // Require order to sit for at least 100ms (latency simulation)
            if (orderAge >= 100) {
                if (order.side === "BUY") {
                    if (low > 0 && low < order.price) {
                        // O mercado negociou ABAIXO do nosso limite: fomos varridos.
                        filled = true;
                    } else if (low > 0 && low <= order.price && bestBid > 0 && order.price >= bestBid) {
                        // Estamos no topo do book e o preço encostou: drena a fila.
                        simData.queuePosition -= tickVolume * SIDE_SHARE;
                        if (simData.queuePosition <= 0) filled = true;
                    }
                } else {
                    if (high > 0 && high > order.price) {
                        filled = true;
                    } else if (high > 0 && high >= order.price && bestAsk > 0 && order.price <= bestAsk) {
                        simData.queuePosition -= tickVolume * SIDE_SHARE;
                        if (simData.queuePosition <= 0) filled = true;
                    }
                }
            }

            if (filled) {
                this.settleFill(pair, order.symbol, order.side, truncatedQty, order.price, orderId, "SIM_LIMIT_MAKER");
                toDelete.push(orderId);
            }
        }

        for (const id of toDelete) {
            this.activeOrders.delete(id);
        }
    }

    /**
     * Liquida um preenchimento: cobra a taxa, move os saldos virtuais, registra a
     * transação e empurra o ExecutionReport mock.
     *
     * Extraído de `evaluateFills` para que as ordens a mercado usem exatamente a mesma
     * contabilidade — duas cópias divergiriam na primeira mudança de regra de taxa.
     */
    private settleFill(
        pair: Pair,
        symbol: string,
        side: "BUY" | "SELL",
        filledQty: number,
        price: number,
        orderId: string,
        status: string
    ): OrderFill {
        const filledQuote = filledQty * price;

        let quoteSym = "";
        let baseSym = "";
        pair.applyCurrencies((b, q) => {
            b.applySymbol(s => baseSym = s.toUpperCase());
            q.applySymbol(s => quoteSym = s.toUpperCase());
        });

        // NOTA: o simulador aplica a mesma taxa para maker e taker. Na Binance real a promo
        // de taxa zero do FDUSD pode valer só para maker — se for o caso, o custo das ordens
        // a mercado está subestimado aqui. Medir com scripts/binance-audit.ts.
        const isFdusd = quoteSym === "FDUSD";
        const zeroFeePromoBases = ['BTC', 'BNB', 'DOGE', 'ETH', 'LINK', 'SOL', 'XRP'];
        const isZeroFeePromo = isFdusd && zeroFeePromoBases.includes(baseSym);
        const feeRate = isZeroFeePromo ? 0 : this.BASE_FEE_RATE;

        let feeInQuote = 0;
        let commission = 0;
        let commissionAsset = "";

        if (side === "BUY") {
            this._quoteBalance -= filledQuote;
            const feeBase = filledQty * feeRate;
            this._baseBalance += (filledQty - feeBase);
            feeInQuote = feeBase * price;
            commission = feeBase;
            commissionAsset = baseSym;
        } else {
            this._baseBalance -= filledQty;
            const feeQuote = filledQuote * feeRate;
            this._quoteBalance += (filledQuote - feeQuote);
            feeInQuote = feeQuote;
            commission = feeQuote;
            commissionAsset = quoteSym;
        }

        this.totalFeesCollected += feeInQuote;

        const executedQtyAmt = new Amount(filledQty);
        const cummulativeQuoteQtyAmt = new Amount(filledQuote);
        const averagePriceAmt = new Amount(price);

        this.logTrade(symbol, executedQtyAmt, averagePriceAmt, status);

        if (this.userDataStream) {
            let mockOrderIdNum = 0;
            try {
                const numericPart = orderId.replace(/[^0-9]/g, '').substring(0, 8);
                mockOrderIdNum = numericPart ? parseInt(numericPart) : Date.now();
            } catch (e) { mockOrderIdNum = Date.now(); }

            const report: ExecutionReport = {
                symbol,
                orderId: mockOrderIdNum,
                clientOrderId: orderId,
                side,
                type: status.startsWith("SIM_MARKET") ? "MARKET" : "LIMIT",
                timeInForce: "GTC",
                originalQty: filledQty,
                originalPrice: price,
                executionType: "TRADE",
                orderStatus: "FILLED",
                lastFilledQty: filledQty,
                accumulatedFilledQty: filledQty,
                lastFilledPrice: price,
                commissionAsset: commissionAsset,
                commission: commission,
                tradeTime: TimeProvider.now()
            };
            this.userDataStream.pushMockReport(report);
        }

        return new OrderFill(executedQtyAmt, cummulativeQuoteQtyAmt, averagePriceAmt, true);
    }

    /**
     * Ordem a mercado simulada: preenche na hora, sem passar pela fila do `evaluateFills`.
     * É o comportamento correto — um taker consome liquidez existente, não espera fila.
     *
     * O preço vem do topo do book do lado contrário (venda bate no bid, compra no ask).
     * Não modelamos slippage por profundidade: com os lotes deste bot (dezenas de FDUSD)
     * uma ordem cabe inteira no topo do BTCFDUSD. Para lotes maiores isso subestimaria o
     * custo.
     */
    private simulateMarketOrder(side: "BUY" | "SELL", pair: Pair, amount: Amount): OrderFill {
        let symbol = "";
        pair.applyBinanceSymbol((sym) => { symbol = sym; });

        let amountVal = 0;
        amount.apply((val) => { amountVal = val; });
        if (amountVal <= 0) return OrderFill.failed();

        const book = this.stateManager.retrieveOrderBook(pair);
        const tick = book?.getLatest();
        if (!tick) return OrderFill.failed();

        let execPrice = 0;
        if (side === "SELL") {
            tick.applyTopBid(l => { if (l) l.price.apply(v => execPrice = v); });
        } else {
            tick.applyTopAsk(l => { if (l) l.price.apply(v => execPrice = v); });
        }
        if (execPrice <= 0) return OrderFill.failed();

        const quantityDecimals = this.precisionFetcher.getQuantityDecimals(symbol);
        const factor = Math.pow(10, quantityDecimals);

        // Compra vem em quote, venda em base — converter tudo para base antes de truncar.
        const rawQty = side === "BUY" ? amountVal / execPrice : amountVal;
        const filledQty = Math.floor(rawQty * factor) / factor;
        if (filledQty <= 0) return OrderFill.failed();

        // Um taker não pode gastar o que não tem: sem esta trava o simulador produziria
        // saldo negativo e mascararia o -2010 que a Binance devolveria.
        if (side === "SELL" && filledQty > this._baseBalance) return OrderFill.failed();
        if (side === "BUY" && filledQty * execPrice > this._quoteBalance) return OrderFill.failed();

        return this.settleFill(
            pair, symbol, side, filledQty, execPrice,
            crypto.randomUUID(), `SIM_MARKET_${side}`
        );
    }

    public async executeMarketSell(pair: Pair, baseAmount: Amount): Promise<OrderFill> {
        return this.simulateMarketOrder("SELL", pair, baseAmount);
    }

    public async executeMarketBuy(pair: Pair, quoteAmount: Amount): Promise<OrderFill> {
        return this.simulateMarketOrder("BUY", pair, quoteAmount);
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

        let truncatedQty = Math.floor(baseQuantityRaw * factor) / factor;
        if (truncatedQty <= 0) return null;

        // Espelha o mesmo arredondamento para cima do BinanceOrderExecutor: o truncamento
        // ao stepSize pode derrubar o notional de volta abaixo do mínimo da exchange. Sem
        // isso o simulador aceita silenciosamente ordens que a Binance real rejeitaria com
        // -1013 NOTIONAL, divergindo do comportamento ao vivo.
        const minNotional = this.precisionFetcher.getMinNotional(symbol);
        if (truncatedQty * roundedPrice < minNotional && roundedPrice > 0) {
            const requiredQty = minNotional / roundedPrice;
            truncatedQty = Math.ceil(requiredQty * factor) / factor;
        }

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
            timestamp: TimeProvider.now()
        };

        // Fila à nossa frente, em unidades do ativo base.
        //
        // Antes eram US$ 10.000 fixos por nível. Medindo o BTCFDUSD real, a profundidade
        // por nível no topo do book gira em algumas centenas de FDUSD — a fila antiga era
        // ~20× mais funda do que a realidade em cima, o que por si só travaria execuções;
        // mas combinada com um dreno de 15% do volume total da barra a cada toque, o
        // resultado líquido era otimista demais. Agora a estimativa é explícita e
        // configurável, para poder ser calibrada contra fills reais.
        const minBaseQueue = this.queueAheadQuote / roundedPrice;
        const initialQueuePosition = Math.max(truncatedQty * 3, minBaseQueue);

        this.activeOrders.set(activeOrder.orderId, { 
            order: activeOrder, 
            pair, 
            amountVal, 
            truncatedQty,
            queuePosition: initialQueuePosition
        });
        return activeOrder;
    }



    private logTrade(symbol: string, quantity: Amount, price: Amount, status: string): void {
        let rawQty = 0;
        let rawPrice = 0;
        quantity.apply((val) => rawQty = val);
        price.apply((val) => rawPrice = val);

        console.log(`🧪 [SIM] ${status} | ${symbol} | Qty: ${rawQty} | Price: ${rawPrice} | Base: ${this._baseBalance.toFixed(6)} | Quote: ${this._quoteBalance.toFixed(2)}`);

        const entry = new TransactionLogEntry(
            new LogId(crypto.randomUUID()),
            new Timestamp(TimeProvider.now()),
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
