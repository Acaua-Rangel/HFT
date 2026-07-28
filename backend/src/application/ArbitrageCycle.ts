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
    minProfit: Amount
  ): Promise<Amount> {
    let firstPairToFetchFee: Pair | undefined;
    pairs.apply((first) => {
      firstPairToFetchFee = first;
    });

    const fee = await feeFetcher.fetchFeeFor(firstPairToFetchFee!);
    const profit = this.evaluator.evaluate(pairs, fee, initialAmount);
    
    const isViable = mathEngine.isProfitable(profit, minProfit);
    if (!isViable) {
      return profit;
    }

    this.executor.executeCycle(pairs, initialAmount);
    return profit;
  }
}
