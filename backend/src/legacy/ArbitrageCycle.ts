import { CycleEvaluator } from "./CycleEvaluator";
import { CycleExecutor } from "./CycleExecutor";
import { FeeFetcher } from "../domain/interfaces/FeeFetcher";
import { MathEngine } from "../domain/interfaces/MathEngine";
import { TriangularPairs } from "./TriangularPairs";
import { Amount } from "../domain/valueObjects/Amount";
import { Pair } from "../domain/valueObjects/Pair";
import { StateManager } from "../domain/interfaces/StateManager";
import { Currency } from "../domain/valueObjects/Currency";

export class ArbitrageCycle {
  constructor(
    private readonly evaluator: CycleEvaluator,
    private readonly executor: CycleExecutor
  ) {}

  /**
   * Avalia o lucro teórico de um ciclo SEM executar ordens.
   * Usado para sondar múltiplos tamanhos de lote rapidamente.
   */
  public evaluateOnly(
    pairs: TriangularPairs,
    feeFetcher: FeeFetcher,
    mathEngine: MathEngine,
    initialAmount: Amount,
    stateManager?: StateManager
  ): Amount {
    let fee1: any, fee2: any, fee3: any;

    pairs.apply((first, second, third) => {
      fee1 = feeFetcher.getFeeFor(first);
      fee2 = feeFetcher.getFeeFor(second);
      fee3 = feeFetcher.getFeeFor(third);
    });

    return this.evaluator.evaluate(pairs, fee1, fee2, fee3, initialAmount);
  }

  public async evaluateAndExecute(
    pairs: TriangularPairs,
    feeFetcher: FeeFetcher,
    mathEngine: MathEngine,
    initialAmount: Amount,
    minProfit: Amount,
    stateManager?: StateManager
  ): Promise<Amount> {
    let fee1: any, fee2: any, fee3: any;
    
    pairs.apply((first, second, third) => {
      fee1 = feeFetcher.getFeeFor(first);
      fee2 = feeFetcher.getFeeFor(second);
      fee3 = feeFetcher.getFeeFor(third);
    });

    const profit = this.evaluator.evaluate(pairs, fee1, fee2, fee3, initialAmount);
    
    const isViable = mathEngine.isProfitable(profit, minProfit);
    if (!isViable) {
      return profit; // Return theoretical profit
    }

    const marginValidator = (newInitialAmount: Amount): boolean => {
       const newProfit = this.evaluator.evaluate(pairs, fee1, fee2, fee3, newInitialAmount);
       return mathEngine.isProfitable(newProfit, minProfit);
    };

    const fill = await this.executor.executeCycle(pairs, initialAmount, marginValidator);
    
    let actualProfit = profit;
    fill.apply((qty, quote, price, success) => {
      if (success) {
        actualProfit = quote.subtract(initialAmount);
      }
    });

    return actualProfit;
  }
}
