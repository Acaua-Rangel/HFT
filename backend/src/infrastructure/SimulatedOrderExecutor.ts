import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { LocalStateManager } from "../application/LocalStateManager";
import { VirtualBalanceManager } from "./VirtualBalanceManager";
import { TransactionRepository, TransactionLogEntry, LogId, Timestamp, TradeId, AssetName, MonetaryValue, TradeStatus } from "./database/TransactionRepository";

export class SimulatedOrderExecutor implements OrderExecutor {
  constructor(
    private readonly stateManager: LocalStateManager,
    private readonly balanceManager: VirtualBalanceManager,
    private readonly transactionRepo: TransactionRepository
  ) {}

  public async executeMarketBuy(pair: Pair, amount: Amount): Promise<OrderFill> {
    const book = this.stateManager.retrieveOrderBook(pair);
    const latestTick = book.getLatest();
    
    const hasNoTick = latestTick === undefined;
    if (hasNoTick) {
      return OrderFill.failed();
    }

    const filledQuantity = latestTick.convertBuy(amount);
    const filledQuote = amount;
    
    let averagePrice = new Amount(0);
    latestTick.convertBuy(new Amount(1)).apply((val) => {
        // Price is 1 / val? Tick doesn't expose price directly. 
        // Wait, convertSell(1) returns price.
    });
    averagePrice = latestTick.convertSell(new Amount(1));

    pair.applyCurrencies((base, quote) => {
      this.balanceManager.debit(quote, filledQuote);
      this.balanceManager.credit(base, filledQuantity);
      
      pair.applyBinanceSymbol((symbol) => {
        this.logTrade(symbol, filledQuantity, averagePrice, "SIMULATED");
      });
    });

    return new OrderFill(filledQuantity, filledQuote, averagePrice, true);
  }

  public async executeMarketSell(pair: Pair, amount: Amount): Promise<OrderFill> {
    return this.simulateTrade("SELL", pair, amount);
  }

  public canExecuteBatch(count: number): boolean {
    return true; // Simulation has no rate limits
  }

  private async simulateTrade(side: string, pair: Pair, amount: Amount): Promise<OrderFill> {
    const book = this.stateManager.retrieveOrderBook(pair);
    const latestTick = book.getLatest();
    
    const hasNoTick = latestTick === undefined;
    if (hasNoTick) {
      return OrderFill.failed();
    }

    const filledQuantity = amount;
    const filledQuote = latestTick.convertSell(amount);
    
    const averagePrice = latestTick.convertSell(new Amount(1));

    pair.applyCurrencies((base, quote) => {
      this.balanceManager.debit(base, filledQuantity);
      this.balanceManager.credit(quote, filledQuote);
      
      pair.applyBinanceSymbol((symbol) => {
        this.logTrade(symbol, filledQuantity, averagePrice, "SIMULATED");
      });
    });

    return new OrderFill(filledQuantity, filledQuote, averagePrice, true);
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
      new MonetaryValue(0), // Profit unknown here
      new TradeStatus(status)
    );
    this.transactionRepo.save(entry);
  }
}
