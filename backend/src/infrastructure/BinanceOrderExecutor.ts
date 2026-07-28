import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "./database/ErrorLogRepository";
import { TransactionRepository, TransactionLogEntry, LogId, Timestamp, TradeId, AssetName, MonetaryValue, TradeStatus } from "./database/TransactionRepository";
import { createHmac } from "crypto";

export class BinanceOrderExecutor implements OrderExecutor {
  constructor(
    private readonly errorLogger: ErrorLogRepository,
    private readonly transactionRepo: TransactionRepository
  ) {}

  public async executeMarketBuy(pair: Pair, amount: Amount): Promise<OrderFill> {
    return this.sendRestRequest("BUY", pair, amount);
  }

  public async executeMarketSell(pair: Pair, amount: Amount): Promise<OrderFill> {
    return this.sendRestRequest("SELL", pair, amount);
  }

  private async sendRestRequest(side: string, pair: Pair, amount: Amount): Promise<OrderFill> {
    let symbol = "";
    pair.applyBinanceSymbol((sym) => { symbol = sym; });

    let amountVal = 0;
    amount.apply((val) => { amountVal = val; });

    const apiKey = process.env.BINANCE_API_KEY || "";
    const apiSecret = process.env.BINANCE_API_SECRET || "";

    const timestamp = Date.now();
    let queryString = `symbol=${symbol}&side=${side}&type=MARKET&timestamp=${timestamp}`;

    if (side === "BUY") {
      queryString += `&quoteOrderQty=${amountVal}`;
    } else {
      queryString += `&quantity=${amountVal}`;
    }

    const signature = createHmac("sha256", apiSecret).update(queryString).digest("hex");
    const url = `https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "X-MBX-APIKEY": apiKey,
        },
      });

      if (!response.ok) {
        return OrderFill.failed();
      }

      const data: any = await response.json();
      
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
      return OrderFill.failed();
    }
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
