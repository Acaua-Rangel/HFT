import { ArbitrageCycle } from "../src/legacy/ArbitrageCycle";
import { CycleEvaluator } from "../src/legacy/CycleEvaluator";
import { CycleExecutor } from "../src/legacy/CycleExecutor";
import { ArbitrageMathEngine } from "../src/legacy/ArbitrageMathEngine";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { TriangularPairs, PairTuple } from "../src/legacy/TriangularPairs";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Fee } from "../src/domain/valueObjects/Fee";
import { OrderFill } from "../src/domain/valueObjects/OrderFill";
import { OrderExecutor } from "../src/domain/interfaces/OrderExecutor";

// Mocks
const stateManager = new LocalStateManager();
const mathEngine = new ArbitrageMathEngine();

class MockExecutor implements OrderExecutor {
  async executeMakerBuy(pair: Pair, amount: Amount): Promise<OrderFill> {
    return new OrderFill(amount, amount, new Amount(1), true);
  }
  async executeMakerSell(pair: Pair, amount: Amount): Promise<OrderFill> {
    return new OrderFill(amount, amount, new Amount(1), true);
  }
  async executeIocSell(pair: Pair, amount: Amount, slippage?: number): Promise<OrderFill> {
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
  getFeeFor: () => new Fee(new Amount(0.001)) // 0.1% fee
};

const initialAmount = new Amount(1000);
const minProfit = new Amount(-1000000); // Always execute

async function runBenchmark() {
  console.log("Warming up...");
  for (let i = 0; i < 10000; i++) {
    await arbitrageCycle.evaluateAndExecute(triangle, mockFeeFetcher as any, mathEngine, initialAmount, minProfit, false);
  }

  console.log("Running benchmark...");
  const start = performance.now();
  const iterations = 100000;
  for (let i = 0; i < iterations; i++) {
    await arbitrageCycle.evaluateAndExecute(triangle, mockFeeFetcher as any, mathEngine, initialAmount, minProfit, false);
  }
  const end = performance.now();
  
  const totalMs = end - start;
  const msPerCycle = totalMs / iterations;
  console.log(`Total time for ${iterations} iterations: ${totalMs.toFixed(2)}ms`);
  console.log(`Average time per cycle execution (Math + SafeQty Logic): ${msPerCycle.toFixed(4)}ms (${(msPerCycle * 1000).toFixed(2)} microseconds)`);
}

runBenchmark();
