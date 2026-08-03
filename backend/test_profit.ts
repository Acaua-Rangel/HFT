import { ArbitrageCycle } from "./src/application/ArbitrageCycle";
import { ArbitrageMathEngine } from "./src/application/ArbitrageMathEngine";
import { CycleEvaluator } from "./src/application/CycleEvaluator";
import { CycleExecutor } from "./src/application/CycleExecutor";
import { LocalStateManager } from "./src/application/LocalStateManager";
import { PairTuple, TriangularPairs } from "./src/application/TriangularPairs";
import type { FeeFetcher } from "./src/domain/interfaces/FeeFetcher";
import { Amount } from "./src/domain/valueObjects/Amount";
import { Currency } from "./src/domain/valueObjects/Currency";
import { Fee } from "./src/domain/valueObjects/Fee";
import { Pair } from "./src/domain/valueObjects/Pair";
import { BinancePriceIngestor } from "./src/infrastructure/BinancePriceIngestor";

class MockFeeFetcher implements FeeFetcher {
	preloadFees(_pairs: Pair[]): Promise<void> {
		return Promise.resolve();
	}
	getFeeFor(_pair: Pair): Fee {
		return new Fee(new Amount(0.001));
	}
}

const stateManager = new LocalStateManager();
const mathEngine = new ArbitrageMathEngine();
const cycleEvaluator = new CycleEvaluator(stateManager, mathEngine);
const mockExecutor = { executeCycle: async () => {} } as any;
const cycleExecutor = new CycleExecutor(
	() => mockExecutor,
	null as any,
	null as any,
);
const arbitrageCycle = new ArbitrageCycle(cycleEvaluator, cycleExecutor);
const ingestor = new BinancePriceIngestor();

const brl = new Currency("BRL");
const usdt = new Currency("USDT");
const btc = new Currency("BTC");

const triangle = new TriangularPairs(
	new PairTuple(new Pair(usdt, brl), new Pair(btc, usdt)),
	new Pair(btc, brl),
);

stateManager.registerPair(new Pair(usdt, brl));
stateManager.registerPair(new Pair(btc, usdt));
stateManager.registerPair(new Pair(btc, brl));
ingestor.subscribe(new Pair(usdt, brl));
ingestor.subscribe(new Pair(btc, usdt));
ingestor.subscribe(new Pair(btc, brl));

setTimeout(async () => {
	const feeFetcher = new MockFeeFetcher();
	const usableAmount = new Amount(1000);
	const minProfit = new Amount(0.1);

	const profitAmount = await arbitrageCycle.evaluateAndExecute(
		triangle,
		feeFetcher,
		mathEngine,
		usableAmount,
		minProfit,
		true,
		stateManager,
	);

	let realProfit = 0;
	profitAmount.apply((v) => (realProfit = v));
	console.log("PROFIT:", realProfit);
	process.exit(0);
}, 3000);
