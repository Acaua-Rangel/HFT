import { describe, expect, it, mock } from "bun:test";
import { ArbitrageCycle } from "../src/legacy/ArbitrageCycle";
import { CycleEvaluator } from "../src/legacy/CycleEvaluator";
import { CycleExecutor } from "../src/legacy/CycleExecutor";
import { FeeFetcher } from "../src/domain/interfaces/FeeFetcher";
import { MathEngine } from "../src/domain/interfaces/MathEngine";
import { StateManager } from "../src/domain/interfaces/StateManager";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Fee } from "../src/domain/valueObjects/Fee";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { TriangularPairs, PairTuple } from "../src/legacy/TriangularPairs";
import { Tick } from "../src/domain/valueObjects/Tick";
import { OrderFill } from "../src/domain/valueObjects/OrderFill";

describe("ArbitrageCycle", () => {
  const usdt = new Currency("USDT");
  const brl = new Currency("BRL");
  const btc = new Currency("BTC");

  const btcUsdtBrlPairs = new TriangularPairs(
    new PairTuple(new Pair(usdt, brl), new Pair(btc, usdt)),
    new Pair(btc, brl)
  );

  const initialAmount = new Amount(100);
  const minProfit = new Amount(0.10);

  it("should evaluate profit without executing when evaluateOnly is called", () => {
    const mockEvaluator = {
      evaluate: mock(() => new Amount(10.5))
    } as unknown as CycleEvaluator;

    const mockExecutor = {
      executeCycle: mock(async () => OrderFill.failed())
    } as unknown as CycleExecutor;

    const mockFeeFetcher: FeeFetcher = {
      preloadFees: async () => {},
      getFeeFor: () => new Fee(new Amount(0.001))
    };

    const mockMathEngine: MathEngine = {
      calculateArbitrageProfit: () => new Amount(0),
      isProfitable: () => false
    };

    const cycle = new ArbitrageCycle(mockEvaluator, mockExecutor);

    const profit = cycle.evaluateOnly(
      btcUsdtBrlPairs,
      mockFeeFetcher,
      mockMathEngine,
      initialAmount,
      false
    );

    let profitVal = 0;
    profit.apply(v => profitVal = v);

    expect(profitVal).toBe(10.5);
    expect(mockEvaluator.evaluate).toHaveBeenCalledTimes(1);
    expect(mockExecutor.executeCycle).not.toHaveBeenCalled();
  });

  it("should return profit and NOT execute when evaluateAndExecute finds it is not profitable", async () => {
    const mockEvaluator = {
      evaluate: mock(() => new Amount(0.05))
    } as unknown as CycleEvaluator;

    const mockExecutor = {
      executeCycle: mock(async () => OrderFill.failed())
    } as unknown as CycleExecutor;

    const mockFeeFetcher: FeeFetcher = {
      preloadFees: async () => {},
      getFeeFor: () => new Fee(new Amount(0.001))
    };

    const mockMathEngine: MathEngine = {
      calculateArbitrageProfit: () => new Amount(0),
      isProfitable: mock(() => false) // Not profitable
    };

    const cycle = new ArbitrageCycle(mockEvaluator, mockExecutor);

    const actualProfit = await cycle.evaluateAndExecute(
      btcUsdtBrlPairs,
      mockFeeFetcher,
      mockMathEngine,
      initialAmount,
      minProfit,
      false
    );

    let val = 0;
    actualProfit.apply(v => val = v);

    expect(val).toBe(0.05); // Should return theoretical profit
    expect(mockMathEngine.isProfitable).toHaveBeenCalledTimes(1);
    expect(mockExecutor.executeCycle).not.toHaveBeenCalled();
  });

  it("should execute and return actual fill profit when evaluateAndExecute finds it is profitable", async () => {
    const mockEvaluator = {
      evaluate: mock(() => new Amount(5))
    } as unknown as CycleEvaluator;

    const fillReturn = new OrderFill(new Amount(105), new Amount(105), new Amount(1), true);

    const mockExecutor = {
      executeCycle: mock(async () => fillReturn)
    } as unknown as CycleExecutor;

    const mockFeeFetcher: FeeFetcher = {
      preloadFees: async () => {},
      getFeeFor: () => new Fee(new Amount(0.001))
    };

    const mockMathEngine: MathEngine = {
      calculateArbitrageProfit: () => new Amount(0),
      isProfitable: mock(() => true) // Is profitable!
    };

    const cycle = new ArbitrageCycle(mockEvaluator, mockExecutor);

    const actualProfit = await cycle.evaluateAndExecute(
      btcUsdtBrlPairs,
      mockFeeFetcher,
      mockMathEngine,
      initialAmount,
      minProfit,
      false
    );

    let val = 0;
    actualProfit.apply(v => val = v);

    expect(val).toBe(5); // 105 (filled quote) - 100 (initial amount) = 5
    expect(mockMathEngine.isProfitable).toHaveBeenCalledTimes(1);
    expect(mockExecutor.executeCycle).toHaveBeenCalledTimes(1);
  });

});
