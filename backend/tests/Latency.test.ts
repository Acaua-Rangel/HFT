import { test, expect } from "bun:test";
import { ArbitrageCycle } from "../src/application/ArbitrageCycle";
import { CycleEvaluator } from "../src/application/CycleEvaluator";
import { CycleExecutor } from "../src/application/CycleExecutor";
import { ArbitrageMathEngine } from "../src/application/ArbitrageMathEngine";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { TriangularPairs, PairTuple } from "../src/application/TriangularPairs";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Pair } from "../domain/valueObjects/Pair";
import { Amount } from "../domain/valueObjects/Amount";
import { Fee } from "../domain/valueObjects/Fee";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import { OrderExecutor } from "../src/domain/interfaces/OrderExecutor";

test("Cycle Latency Benchmark", async () => {
  const stateManager = new LocalStateManager();
  const mathEngine = new ArbitrageMathEngine();

  class MockExecutor implements OrderExecutor {
    async executeMarketBuy(pair: Pair, amount: Amount): Promise<OrderFill> {
      return new OrderFill(amount, amount, new Amount(1), true);
    }
    async executeMarketSell(pair: Pair, amount: Amount): Promise<OrderFill> {
      return new OrderFill(amount, amount, new Amount(1), true);
    }
    canExecuteBatch(count: number): boolean { return true; }
  }
  const mockExecutor = new MockExecutor();

  const cycleExecutor = new CycleExecutor(() => mockExecutor, {} as any, {} as any);
  const cycleEvaluator = new CycleEvaluator(stateManager, mathEngine);
  const arbitrageCycle = new ArbitrageCycle(cycleEvaluator, cycleExecutor);

  const eth = new Currency("ETH");
  const usdt = new Currency("USDT");
  const brl = new Currency("BRL");

  const tuple = new PairTuple(new Pair(usdt, brl), new Pair(eth, usdt));
  const triangle = new TriangularPairs(tuple, new Pair(eth, brl));

  const mockFeeFetcher = {
    getFeeFor: () => new Fee(new Amount(0.001))
  };

  const initialAmount = new Amount(1000);
  const minProfit = new Amount(-1000000);

  // Warmup
  for (let i = 0; i < 1000; i++) {
    await arbitrageCycle.evaluateAndExecute(triangle, mockFeeFetcher as any, mathEngine, initialAmount, minProfit, false);
  }

  const start = performance.now();
  const iterations = 10000;
  for (let i = 0; i < iterations; i++) {
    await arbitrageCycle.evaluateAndExecute(triangle, mockFeeFetcher as any, mathEngine, initialAmount, minProfit, false);
  }
  const end = performance.now();
  
  const totalMs = end - start;
  const msPerCycle = totalMs / iterations;
  
  console.log(`\n[BENCHMARK] Average time per complete cycle evaluation + execution (Math + Dynamic Fee Deductions): ${msPerCycle.toFixed(4)}ms (${(msPerCycle * 1000).toFixed(2)} microseconds)`);
  
  expect(msPerCycle).toBeLessThan(0.1); // Ensure it takes less than 100 microseconds per cycle
});
