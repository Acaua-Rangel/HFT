import { StateManager } from "../domain/interfaces/StateManager";
import { MathEngine } from "../domain/interfaces/MathEngine";
import { Amount } from "../domain/valueObjects/Amount";
import { Fee } from "../domain/valueObjects/Fee";
import { TriangularPairs } from "./TriangularPairs";
import { OrderBook } from "../domain/entities/OrderBook";
import { Pair } from "../domain/valueObjects/Pair";

export class CycleEvaluator {
  constructor(
    private readonly stateManager: StateManager,
    private readonly mathEngine: MathEngine
  ) {}

  public evaluate(pairs: TriangularPairs, fee: Fee, initialAmount: Amount): Amount {
    let profitResult = new Amount(0);

    pairs.apply((first: Pair, second: Pair, third: Pair) => {
      const firstBook = this.stateManager.retrieveOrderBook(first);
      const secondBook = this.stateManager.retrieveOrderBook(second);
      const thirdBook = this.stateManager.retrieveOrderBook(third);

      profitResult = this.mathEngine.calculateArbitrageProfit(
        initialAmount,
        firstBook,
        secondBook,
        thirdBook,
        fee
      );
    });

    return profitResult;
  }
}
