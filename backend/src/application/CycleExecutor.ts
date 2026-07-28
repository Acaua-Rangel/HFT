import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { TriangularPairs } from "./TriangularPairs";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";

export class CycleExecutor {
  constructor(
    private readonly executor: OrderExecutor,
    private readonly timeoutMs: number
  ) {}

  public executeCycle(pairs: TriangularPairs, initialAmount: Amount): void {
    pairs.apply((first: Pair, second: Pair, third: Pair) => {
      this.executor.executeMarketBuy(first, initialAmount);
      
      const mockedSecondAmount = new Amount(0);
      this.executor.executeMarketBuy(second, mockedSecondAmount);
      
      const mockedThirdAmount = new Amount(0);
      this.executor.executeMarketSellWithTimeout(third, mockedThirdAmount, this.timeoutMs);
    });
  }
}
