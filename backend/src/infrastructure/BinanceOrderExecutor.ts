import { OrderExecutor, ActiveOrder } from "../domain/interfaces/OrderExecutor";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "./database/ErrorLogRepository";
import { TransactionRepository, TransactionLogEntry, LogId, Timestamp, TradeId, AssetName, MonetaryValue, TradeStatus } from "./database/TransactionRepository";
import { BinanceWsClient, WsResponse } from "./BinanceWsClient";
import { ExecutionRateLimiter } from "./ExecutionRateLimiter";
import { BinancePrecisionFetcher } from "./BinancePrecisionFetcher";
import { StateManager } from "../domain/interfaces/StateManager";
import * as crypto from "crypto";

export class BinanceOrderExecutor implements OrderExecutor {
  private rateLimiter: ExecutionRateLimiter;
  private isConnecting = false;

  constructor(
    private wsClient: BinanceWsClient,
    private readonly errorLogger: ErrorLogRepository,
    private readonly transactionRepo: TransactionRepository,
    private readonly precisionFetcher: BinancePrecisionFetcher,
    private readonly stateManager: StateManager
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

    public async executeMakerBuy(pair: Pair, amount: Amount, price?: Amount): Promise<ActiveOrder | null> {
    return this.sendWsOrder("BUY", pair, amount, price);
  }

  public async executeMakerSell(pair: Pair, amount: Amount, price?: Amount): Promise<ActiveOrder | null> {
    return this.sendWsOrder("SELL", pair, amount, price);
  }

  public canExecuteBatch(count: number): boolean {
    return this.rateLimiter.hasCapacityFor(count);
  }

  private async sendWsOrder(side: "BUY" | "SELL", pair: Pair, amount: Amount, price?: Amount): Promise<ActiveOrder | null> {
    await this.ensureConnected();
    if (!this.wsClient.isReady()) return null;

    let symbol = "";
    pair.applyBinanceSymbol((sym) => { symbol = sym; });

    let amountVal = 0;
    amount.apply((val) => { amountVal = val; });

    if (!this.rateLimiter.hasCapacityFor(1)) {
      this.logError("RATE_LIMIT", "Not enough quota to place order");
      return null;
    }

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
    
    const priceDecimals = tickSize.toString().includes(".") ? (tickSize.toString().split(".")[1]?.length || 0) : 0;
    const priceStr = roundedPrice.toFixed(priceDecimals);

    const factor = Math.pow(10, quantityDecimals);
    let baseQuantityRaw = 0;
    if (side === "BUY") {
        baseQuantityRaw = amountVal / roundedPrice;
    } else {
        baseQuantityRaw = amountVal;
    }

    const truncatedQty = Math.floor(baseQuantityRaw * factor) / factor;
    if (truncatedQty <= 0) {
        this.logError("ORDER_TRUNCATED_TO_ZERO", `Raw qty ${baseQuantityRaw} truncated to 0`);
        return null;
    }

    const params: any = {
      symbol,
      side,
      type: "LIMIT_MAKER",
      price: priceStr,
      quantity: truncatedQty.toFixed(quantityDecimals),
      newOrderRespType: "RESULT"
    };

    this.rateLimiter.recordUsage(1);
    try {
      const placeRes: WsResponse = await this.wsClient.sendRequest("order.place", params, 2000);

      if (placeRes.status !== 200) {
          const errorMsg = placeRes.error?.msg?.toLowerCase() || "";
          if (errorMsg.includes("match and take")) {
              this.logError("ORDER_REJECTED_POST_ONLY_CROSSING", JSON.stringify(placeRes.error));
          } else {
              this.logError("ORDER_REJECTED", JSON.stringify(placeRes.error));
          }
          return null;
      }

      return {
          orderId: placeRes.result.orderId,
          symbol,
          side,
          price: roundedPrice,
          qty: truncatedQty,
          timestamp: Date.now()
      };
    } catch (err) {
      this.logError("ORDER_EXCEPTION", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  public async cancelOrder(order: ActiveOrder): Promise<OrderFill> {
      await this.ensureConnected();
      if (!this.wsClient.isReady()) return OrderFill.failed();

      this.rateLimiter.recordUsage(1);
      try {
          const cancelRes: WsResponse = await this.wsClient.sendRequest("order.cancel", { symbol: order.symbol, orderId: order.orderId }, 2000);
          
          let finalStatusData = cancelRes.result;

          if (cancelRes.status !== 200) {
            if (cancelRes.error?.code === -2011) {
                this.rateLimiter.recordUsage(1);
                const statusRes = await this.wsClient.sendRequest("order.status", { symbol: order.symbol, orderId: order.orderId }, 2000);
                if (statusRes.status === 200) {
                  finalStatusData = statusRes.result;
                } else {
                  return OrderFill.failed();
                }
            } else {
                this.logError("CANCEL_FAILED", JSON.stringify(cancelRes.error));
                return OrderFill.failed();
            }
          }

          const executedQtyStr = finalStatusData.executedQty || "0";
          const cummulativeQuoteQtyStr = finalStatusData.cummulativeQuoteQty || "0";
          
          const executedQty = parseFloat(executedQtyStr);
          const quoteQty = parseFloat(cummulativeQuoteQtyStr);
          
          if (executedQty === 0) return OrderFill.failed();

          const averagePriceVal = quoteQty / executedQty;
          
          const executedQtyAmt = new Amount(executedQty);
          const cummulativeQuoteQtyAmt = new Amount(quoteQty);
          const averagePriceAmt = new Amount(averagePriceVal);

          this.logTrade(order.symbol, executedQtyAmt, averagePriceAmt, "LIMIT_MAKER");
          return new OrderFill(executedQtyAmt, cummulativeQuoteQtyAmt, averagePriceAmt, true);
      } catch (err) {
          this.logError("CANCEL_EXCEPTION", err instanceof Error ? err.message : String(err));
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
