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
import { Tick } from "./src/domain/valueObjects/Tick";

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

const brl = new Currency("BRL");
const usdt = new Currency("USDT");

const activeTriangles: TriangularPairs[] = [];
for (let i = 0; i < 17; i++) {
	const base = new Currency(`COIN${i}`);
	activeTriangles.push(
		new TriangularPairs(
			new PairTuple(new Pair(usdt, brl), new Pair(base, usdt)),
			new Pair(base, brl),
		),
	);
}

stateManager.updateState(
	new Tick(
		new Pair(usdt, brl),
		[{ price: new Amount(5), qty: new Amount(1000) }],
		[{ price: new Amount(5), qty: new Amount(1000) }],
	),
);
stateManager.updateState(
	new Tick(
		new Pair(new Currency("BNB"), usdt),
		[{ price: new Amount(550), qty: new Amount(10) }],
		[{ price: new Amount(550), qty: new Amount(10) }],
	),
);

for (let i = 0; i < 17; i++) {
	const base = new Currency(`COIN${i}`);
	stateManager.updateState(
		new Tick(
			new Pair(base, usdt),
			[{ price: new Amount(2), qty: new Amount(100) }],
			[{ price: new Amount(2), qty: new Amount(100) }],
		),
	);
	stateManager.updateState(
		new Tick(
			new Pair(base, brl),
			[{ price: new Amount(10), qty: new Amount(100) }],
			[{ price: new Amount(10), qty: new Amount(100) }],
		),
	);
}

async function runBenchmark() {
	const feeFetcher = new MockFeeFetcher();
	const usableAmount = new Amount(1000);
	const minProfit = new Amount(10);

	for (let i = 0; i < 1000; i++) {
		for (const triangle of activeTriangles) {
			await arbitrageCycle.evaluateAndExecute(
				triangle,
				feeFetcher,
				mathEngine,
				usableAmount,
				minProfit,
				true,
				stateManager,
			);
		}
	}

	const iterations = 10000;
	const start = process.hrtime.bigint();

	for (let i = 0; i < iterations; i++) {
		for (const triangle of activeTriangles) {
			await arbitrageCycle.evaluateAndExecute(
				triangle,
				feeFetcher,
				mathEngine,
				usableAmount,
				minProfit,
				true,
				stateManager,
			);
		}
	}

	const end = process.hrtime.bigint();
	const totalNs = end - start;
	const totalMs = Number(totalNs) / 1e6;

	const timePerFullLoopMs = totalMs / iterations;
	const timePerTriangleMs = timePerFullLoopMs / 17;

	console.log(
		`[BENCHMARK] Time to process ALL 17 Triangles sequentially on a single tick: ${timePerFullLoopMs.toFixed(5)} ms`,
	);
	console.log(
		`[BENCHMARK] Time to process 1 Triangle individually: ${timePerTriangleMs.toFixed(5)} ms`,
	);

	if (timePerFullLoopMs < 1.0) {
		console.log(`✅ SUCCESS: Total processing time is UNDER 1 millisecond!`);
	} else {
		console.log(`❌ FAILED: Total processing time is over 1 millisecond.`);
	}
}

runBenchmark().catch(console.error);
