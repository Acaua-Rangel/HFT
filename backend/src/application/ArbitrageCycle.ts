import { CycleEvaluator } from "./CycleEvaluator";
import { CycleExecutor } from "./CycleExecutor";
import { FeeFetcher } from "../domain/interfaces/FeeFetcher";
import { MathEngine } from "../domain/interfaces/MathEngine";
import { TriangularPairs } from "./TriangularPairs";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";

export class ArbitrageCycle {
  constructor(
    private readonly evaluator: CycleEvaluator,
    private readonly executor: CycleExecutor
  ) {}

  public async evaluateAndExecute(
    pairs: TriangularPairs,
    feeFetcher: FeeFetcher,
    mathEngine: MathEngine,
    initialAmount: Amount,
    minProfit: Amount,
    bnbDiscount: boolean = false
  ): Promise<Amount> {
    let fee1: any, fee2: any, fee3: any;
    
    pairs.apply((first, second, third) => {
      fee1 = feeFetcher.getFeeFor(first);
      fee2 = feeFetcher.getFeeFor(second);
      fee3 = feeFetcher.getFeeFor(third);
    });

    if (bnbDiscount) {
      fee1 = fee1.withBnbDiscount();
      fee2 = fee2.withBnbDiscount();
      fee3 = fee3.withBnbDiscount();
    }

    const profit = this.evaluator.evaluate(pairs, fee1, fee2, fee3, initialAmount);
    
    const isViable = mathEngine.isProfitable(profit, minProfit);
    if (!isViable) {
      return profit; // Return theoretical profit
    }

    const fill = await this.executor.executeCycle(pairs, initialAmount);
    
    let actualProfit = profit;
    fill.apply((qty, quote, price, success) => {
      if (success) {
        actualProfit = quote.subtract(initialAmount);
      }
    });

    return actualProfit;
  }
}
