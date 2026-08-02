import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { TriangularPairs } from "./TriangularPairs";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "../infrastructure/database/ErrorLogRepository";
import { TransactionRepository } from "../infrastructure/database/TransactionRepository";

export class CycleExecutor {
  constructor(
    private readonly executorProvider: () => OrderExecutor,
    private readonly errorRepo: ErrorLogRepository,
    private readonly transactionRepo: TransactionRepository
  ) {}

  public async executeCycle(pairs: TriangularPairs, initialAmount: Amount, fee1?: any, fee2?: any): Promise<OrderFill> {
    let finalFill = OrderFill.failed();
    const executor = this.executorProvider();

    if (!executor.canExecuteBatch(3)) {
      return OrderFill.failed();
    }

    await pairs.applyAsync(async (first: Pair, second: Pair, third: Pair) => {
      try {
        const fill1 = await this.executeWithTimeout(() => executor.executeMarketBuy(first, initialAmount), 5000);
        
        let isSuccess1 = false;
        let qty1 = new Amount(0);
        fill1.apply((q, quote, p, s) => { isSuccess1 = s; qty1 = q; });

        if (!isSuccess1) {
          finalFill = OrderFill.failed();
          return;
        }

        let isSuccess2 = false;
        let qty2 = new Amount(0);
        
        // Aplica a dedução da taxa real (dinâmica) obtida da Binance para garantir saldo suficiente,
        // e trunca para 4 casas decimais para evitar erros de LOT_SIZE.
        let deductedQty1 = fee1 ? fee1.deductFrom(qty1) : qty1;
        let safeQty1Val = 0;
        deductedQty1.apply((v: number) => safeQty1Val = Math.floor(v * 10000) / 10000);
        const safeQty1 = new Amount(safeQty1Val);

        const fill2 = await this.executeWithTimeout(() => executor.executeMarketBuy(second, safeQty1), 5000);
        
        fill2.apply((q, quote, p, s) => { isSuccess2 = s; qty2 = q; });

        if (!isSuccess2) {
          await this.handleBrokenLeg(executor, first, safeQty1, "Leg 2 failed");
          finalFill = OrderFill.failed();
          return;
        }

        let deductedQty2 = fee2 ? fee2.deductFrom(qty2) : qty2;
        let safeQty2Val = 0;
        deductedQty2.apply((v: number) => safeQty2Val = Math.floor(v * 10000) / 10000);
        const safeQty2 = new Amount(safeQty2Val);

        const fill3 = await this.executeWithTimeout(() => executor.executeMarketSell(third, safeQty2), 5000);
        
        let isSuccess3 = false;
        fill3.apply((q, quote, p, s) => { isSuccess3 = s; });

        if (!isSuccess3) {
          await this.handleBrokenLeg(executor, second, safeQty2, "Leg 3 failed");
          finalFill = OrderFill.failed();
          return;
        }

        finalFill = fill3;
      } catch (err) {
        finalFill = OrderFill.failed();
      }
    });

    return finalFill;
  }

  private async executeWithTimeout(operation: () => Promise<OrderFill>, timeoutMs: number): Promise<OrderFill> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(OrderFill.failed());
      }, timeoutMs);
      
      operation().then((res) => {
        clearTimeout(timeout);
        resolve(res);
      }).catch(() => {
        clearTimeout(timeout);
        resolve(OrderFill.failed());
      });
    });
  }

  private async handleBrokenLeg(executor: OrderExecutor, pairToRevert: Pair, amount: Amount, reason: string): Promise<void> {
    await executor.executeMarketSell(pairToRevert, amount);
    
    let symbolStr = "";
    pairToRevert.applyBinanceSymbol((s) => symbolStr = s);

    let amountVal = 0;
    amount.apply((v) => amountVal = v);

    const entry = new ErrorLogEntry(
        { asString: () => crypto.randomUUID() } as any,
        { asNumber: () => Date.now() } as any,
        new ErrorType("BROKEN_LEG"),
        new ErrorMessage(`Protection triggered for ${symbolStr}: ${reason}`),
        new StackTrace(null),
        new ErrorContext(JSON.stringify({ amount: amountVal }))
    );
    this.errorRepo.save(entry);
  }
}
