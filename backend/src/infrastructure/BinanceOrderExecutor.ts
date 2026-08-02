import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "./database/ErrorLogRepository";
import { TransactionRepository, TransactionLogEntry, LogId, Timestamp, TradeId, AssetName, MonetaryValue, TradeStatus } from "./database/TransactionRepository";
import { BinanceWsClient, WsResponse } from "./BinanceWsClient";
import { ExecutionRateLimiter } from "./ExecutionRateLimiter";
import { BinancePrecisionFetcher } from "./BinancePrecisionFetcher";

export class BinanceOrderExecutor implements OrderExecutor {
  private rateLimiter: ExecutionRateLimiter;
  private isConnecting = false;

  constructor(
    private wsClient: BinanceWsClient,
    private readonly errorLogger: ErrorLogRepository,
    private readonly transactionRepo: TransactionRepository,
    private readonly precisionFetcher: BinancePrecisionFetcher
  ) {
    this.rateLimiter = new ExecutionRateLimiter(50, 10000); // 50 requests per 10s
    this.ensureConnected();
  }

  public async ensureConnected(): Promise<void> {
    if (this.wsClient.isReady() || this.isConnecting) return;
    this.isConnecting = true;
    try {
      await this.wsClient.connect();
    } catch (err) {
      console.error("WS Connection Failed", err);
    } finally {
      this.isConnecting = false;
    }
  }

  public async executeMarketBuy(pair: Pair, amount: Amount): Promise<OrderFill> {
    return this.sendWsOrder("BUY", pair, amount);
  }

  public async executeMarketSell(pair: Pair, amount: Amount): Promise<OrderFill> {
    return this.sendWsOrder("SELL", pair, amount);
  }

  public canExecuteBatch(count: number): boolean {
    return this.rateLimiter.hasCapacityFor(count);
  }

  private async sendWsOrder(side: string, pair: Pair, amount: Amount): Promise<OrderFill> {
    await this.ensureConnected();

    if (!this.wsClient.isReady()) {
      return OrderFill.failed();
    }

    if (!this.rateLimiter.hasCapacityFor(1)) {
      this.logError("RATE_LIMIT", "Not enough quota to place order");
      return OrderFill.failed();
    }
    this.rateLimiter.recordUsage(1);

    let symbol = "";
    pair.applyBinanceSymbol((sym) => { symbol = sym; });

    let amountVal = 0;
    amount.apply((val) => { amountVal = val; });

    const params: any = {
      symbol,
      side,
      type: "MARKET"
    };

    if (side === "BUY") {
      // Determina a precisão do ativo de cotação (Quote Asset)
      let quoteDecimals = 8;
      if (symbol.endsWith("BRL") || symbol.endsWith("EUR") || symbol.endsWith("TRY")) {
        quoteDecimals = 2;
      } else if (symbol.endsWith("USDT") || symbol.endsWith("USDC") || symbol.endsWith("FDUSD")) {
        quoteDecimals = 4; // Margem segura para stablecoins
      }

      const factor = Math.pow(10, quoteDecimals);
      const truncated = Math.floor(amountVal * factor) / factor;
      
      // O uso de toFixed + parseFloat (ou envio como string) evita bugs de precisão IEEE 754 (ex: 0.10000000000001)
      params.quoteOrderQty = truncated.toFixed(quoteDecimals);
    } else {
      // O LOT_SIZE depende inteiramente do que a API da Binance determinou para o símbolo atual
      const quantityDecimals = this.precisionFetcher.getQuantityDecimals(symbol);

      const factor = Math.pow(10, quantityDecimals);
      const truncated = Math.floor(amountVal * factor) / factor;
      params.quantity = truncated.toFixed(quantityDecimals);
    }

    try {
      const res: WsResponse = await this.wsClient.sendRequest("order.place", params, 2000);

      if (res.status !== 200) {
        this.logError("ORDER_REJECTED", JSON.stringify(res.error));
        return OrderFill.failed();
      }

      const data = res.result;
      const executedQty = new Amount(parseFloat(data.executedQty || "0"));
      const cummulativeQuoteQty = new Amount(parseFloat(data.cummulativeQuoteQty || "0"));
      
      let averagePriceVal = 0;
      cummulativeQuoteQty.apply((c) => {
        executedQty.apply((e) => {
          if (e > 0) averagePriceVal = c / e;
        });
      });
      const averagePrice = new Amount(averagePriceVal);

      const fill = new OrderFill(executedQty, cummulativeQuoteQty, averagePrice, true);
      this.logTrade(symbol, executedQty, averagePrice, "EXECUTED");

      return fill;
    } catch (err) {
      this.logError("ORDER_FAILED", err instanceof Error ? err.message : String(err));
      return OrderFill.failed();
    }
  }

  public forceInjectWsClientForTests(mockClient: BinanceWsClient, mockLimiter: ExecutionRateLimiter): void {
    this.wsClient = mockClient;
    this.rateLimiter = mockLimiter;
  }

  private logError(type: string, message: string): void {
    console.error(`[${type}] ${message}`);
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
