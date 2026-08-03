import { describe, expect, it, mock } from "bun:test";
import { ArbitrageCycle } from "../src/application/ArbitrageCycle";
import type { CycleEvaluator } from "../src/application/CycleEvaluator";
import type { CycleExecutor } from "../src/application/CycleExecutor";
import { PairTuple, TriangularPairs } from "../src/application/TriangularPairs";
import type { FeeFetcher } from "../src/domain/interfaces/FeeFetcher";
import type { MathEngine } from "../src/domain/interfaces/MathEngine";
import type { StateManager } from "../src/domain/interfaces/StateManager";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Fee } from "../src/domain/valueObjects/Fee";
import { OrderFill } from "../src/domain/valueObjects/OrderFill";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Tick } from "../src/domain/valueObjects/Tick";

describe("ArbitrageCycle", () => {
	const usdt = new Currency("USDT");
	const brl = new Currency("BRL");
	const btc = new Currency("BTC");

	const btcUsdtBrlPairs = new TriangularPairs(
		new PairTuple(new Pair(usdt, brl), new Pair(btc, usdt)),
		new Pair(btc, brl),
	);

	const initialAmount = new Amount(100);
	const minProfit = new Amount(0.1);

	it("should evaluate profit without executing when evaluateOnly is called", () => {
		const mockEvaluator = {
			evaluate: mock(() => new Amount(10.5)),
		} as unknown as CycleEvaluator;

		const mockExecutor = {
			executeCycle: mock(async () => OrderFill.failed()),
		} as unknown as CycleExecutor;

		const mockFeeFetcher: FeeFetcher = {
			preloadFees: async () => {},
			getFeeFor: () => new Fee(new Amount(0.001)),
		};

		const mockMathEngine: MathEngine = {
			calculateArbitrageProfit: () => new Amount(0),
			isProfitable: () => false,
		};

		const cycle = new ArbitrageCycle(mockEvaluator, mockExecutor);

		const profit = cycle.evaluateOnly(
			btcUsdtBrlPairs,
			mockFeeFetcher,
			mockMathEngine,
			initialAmount,
			false,
		);

		let profitVal = 0;
		profit.apply((v) => (profitVal = v));

		expect(profitVal).toBe(10.5);
		expect(mockEvaluator.evaluate).toHaveBeenCalledTimes(1);
		expect(mockExecutor.executeCycle).not.toHaveBeenCalled();
	});

	it("should return profit and NOT execute when evaluateAndExecute finds it is not profitable", async () => {
		const mockEvaluator = {
			evaluate: mock(() => new Amount(0.05)),
		} as unknown as CycleEvaluator;

		const mockExecutor = {
			executeCycle: mock(async () => OrderFill.failed()),
		} as unknown as CycleExecutor;

		const mockFeeFetcher: FeeFetcher = {
			preloadFees: async () => {},
			getFeeFor: () => new Fee(new Amount(0.001)),
		};

		const mockMathEngine: MathEngine = {
			calculateArbitrageProfit: () => new Amount(0),
			isProfitable: mock(() => false), // Not profitable
		};

		const cycle = new ArbitrageCycle(mockEvaluator, mockExecutor);

		const actualProfit = await cycle.evaluateAndExecute(
			btcUsdtBrlPairs,
			mockFeeFetcher,
			mockMathEngine,
			initialAmount,
			minProfit,
			false,
		);

		let val = 0;
		actualProfit.apply((v) => (val = v));

		expect(val).toBe(0.05); // Should return theoretical profit
		expect(mockMathEngine.isProfitable).toHaveBeenCalledTimes(1);
		expect(mockExecutor.executeCycle).not.toHaveBeenCalled();
	});

	it("should execute and return actual fill profit when evaluateAndExecute finds it is profitable", async () => {
		const mockEvaluator = {
			evaluate: mock(() => new Amount(5)),
		} as unknown as CycleEvaluator;

		const fillReturn = new OrderFill(
			new Amount(105),
			new Amount(105),
			new Amount(1),
			true,
		);

		const mockExecutor = {
			executeCycle: mock(async () => fillReturn),
		} as unknown as CycleExecutor;

		const mockFeeFetcher: FeeFetcher = {
			preloadFees: async () => {},
			getFeeFor: () => new Fee(new Amount(0.001)),
		};

		const mockMathEngine: MathEngine = {
			calculateArbitrageProfit: () => new Amount(0),
			isProfitable: mock(() => true), // Is profitable!
		};

		const cycle = new ArbitrageCycle(mockEvaluator, mockExecutor);

		const actualProfit = await cycle.evaluateAndExecute(
			btcUsdtBrlPairs,
			mockFeeFetcher,
			mockMathEngine,
			initialAmount,
			minProfit,
			false,
		);

		let val = 0;
		actualProfit.apply((v) => (val = v));

		expect(val).toBe(5); // 105 (filled quote) - 100 (initial amount) = 5
		expect(mockMathEngine.isProfitable).toHaveBeenCalledTimes(1);
		expect(mockExecutor.executeCycle).toHaveBeenCalledTimes(1);
	});

	it("should apply BNB discount rules dynamically based on asset price", () => {
		const bnbFee = new Fee(new Amount(0.001));
		const mockFeeFetcher: FeeFetcher = {
			preloadFees: async () => {},
			getFeeFor: () => bnbFee,
		};

		// StateManager mock providing BNB price and asset price
		const mockStateManager = {
			retrieveOrderBook: mock((pair: Pair) => {
				let sym = "";
				pair.applyBinanceSymbol((s) => (sym = s));

				if (sym === "BNBUSDT") {
					return {
						getLatest: () =>
							new Tick(
								pair,
								[{ price: new Amount(600), qty: new Amount(1) }],
								[],
							),
					};
				}

				// Let's pretend BTCUSDT is $60,000 (enough to pay fee)
				if (sym === "BTCUSDT") {
					return {
						getLatest: () =>
							new Tick(
								pair,
								[{ price: new Amount(60000), qty: new Amount(1) }],
								[],
							),
					};
				}

				// Return a dummy empty book for others
				return { getLatest: () => undefined };
			}),
		} as unknown as StateManager;

		let passedFees: any[] = [];
		const mockEvaluator = {
			evaluate: mock((_pairs: any, f1: any, f2: any, f3: any) => {
				passedFees = [f1, f2, f3];
				return new Amount(10);
			}),
		} as unknown as CycleEvaluator;

		const mockExecutor = {
			executeCycle: mock(async () => OrderFill.failed()),
		} as unknown as CycleExecutor;

		const mockMathEngine: MathEngine = {
			calculateArbitrageProfit: () => new Amount(0),
			isProfitable: () => false,
		};

		const cycle = new ArbitrageCycle(mockEvaluator, mockExecutor);

		// Call evaluateOnly with BNB discount = true
		cycle.evaluateOnly(
			btcUsdtBrlPairs,
			mockFeeFetcher,
			mockMathEngine,
			initialAmount,
			true,
			mockStateManager,
		);

		expect(mockStateManager.retrieveOrderBook).toHaveBeenCalled();

		// Fee 2 is BTC/USDT. Since price is 60000 and BNB is 600, priceInBnb = 100.
		// 100 > 0.00000001, so it IS eligible for BNB discount.
		const f2 = passedFees[1] as Fee;
		expect(f2.isBnbPaid).toBe(true);

		let f2val = 0;
		f2.percentage.apply((v) => (f2val = v));
		expect(f2val).toBe(0.001 * 0.75); // Should have 25% discount applied
	});
});
