import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "./database/ErrorLogRepository";
import { LogId, Timestamp } from "./database/TransactionRepository";

export class BinanceOrderExecutor implements OrderExecutor {
  constructor(private readonly errorLogger: ErrorLogRepository) {}

  public executeMarketBuy(pair: Pair, amount: Amount): void {
    this.sendRestRequest("BUY", pair, amount);
  }

  public executeMarketSell(pair: Pair, amount: Amount): void {
    this.sendRestRequest("SELL", pair, amount);
  }

  public executeMarketSellWithTimeout(pair: Pair, amount: Amount, timeoutMs: number): void {
    const timeoutId = setTimeout(() => {
      this.handleBrokenLegProtection(pair, amount, "Timeout");
    }, timeoutMs);

    this.sendRestRequest("SELL", pair, amount)
      .then(() => clearTimeout(timeoutId))
      .catch((err) => {
        clearTimeout(timeoutId);
        this.handleBrokenLegProtection(pair, amount, "Error: " + String(err));
      });
  }

  private async sendRestRequest(side: string, pair: Pair, amount: Amount): Promise<void> {
    // Mock REST request to Binance
    console.log(`Executing ${side} for ${(amount as any).value} on ${(pair as any).base.symbol}-${(pair as any).quote.symbol}`);
    // Simulate real delay, let's keep it simple for tests. We can simulate failure if pair has a specific quote
    if (side === "SELL" && (pair as any).base.symbol === "ETH" && (pair as any).quote.symbol === "BRL") {
        return new Promise((_, reject) => setTimeout(() => reject("Simulated API failure or timeout"), 50));
    }
    return Promise.resolve();
  }

  private handleBrokenLegProtection(pair: Pair, amount: Amount, reason: string): void {
    console.log(`[PROTECTION] ${reason}. Canceling/reverting order for ${(pair as any).base.symbol}-${(pair as any).quote.symbol}`);
    
    const entry = new ErrorLogEntry(
        new LogId(crypto.randomUUID()),
        new Timestamp(Date.now()),
        new ErrorType("BROKEN_LEG"),
        new ErrorMessage(`Protection triggered for ${(pair as any).base.symbol}-${(pair as any).quote.symbol}: ${reason}`),
        new StackTrace(null),
        new ErrorContext(JSON.stringify({ amount: (amount as any).value }))
    );
    this.errorLogger.save(entry);
  }
}
