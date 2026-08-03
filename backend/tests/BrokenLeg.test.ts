import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { CycleExecutor } from "../src/application/CycleExecutor";
import { PairTuple, TriangularPairs } from "../src/application/TriangularPairs";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";
import { OrderFill } from "../src/domain/valueObjects/OrderFill";
import { Pair } from "../src/domain/valueObjects/Pair";
import {
	AsyncDatabaseWriter,
	ProcessingState,
	QueryQueue,
} from "../src/infrastructure/database/AsyncDatabaseWriter";
import { ErrorLogRepository } from "../src/infrastructure/database/ErrorLogRepository";

describe("Broken Leg Scenario (Risk protection)", () => {
	it("should trigger circuit breaker and log broken leg event for 3rd leg (ETH->BRL) timeout or error", async () => {
		// Setup in-memory mock DB
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE error_logs (id TEXT, timestamp INTEGER, error_type TEXT, message TEXT, stack_trace TEXT, context TEXT)",
		);

		const queue = new QueryQueue();
		const state = new ProcessingState();
		const writer = new AsyncDatabaseWriter(db, queue, state);
		const errorLogger = new ErrorLogRepository(writer);

		// Spy on save method
		const saveSpy = mock(errorLogger.save.bind(errorLogger));
		errorLogger.save = saveSpy as any;

		let executeCalls = 0;
		const mockExecutor = {
			executeMarketBuy: async (_pair: Pair, _amount: Amount) => {
				executeCalls++;
				return new OrderFill(
					new Amount(10),
					new Amount(100),
					new Amount(10),
					true,
				);
			},
			executeMarketSell: async (_pair: Pair, _amount: Amount) => {
				executeCalls++;
				if (executeCalls === 3) {
					// 3rd leg fails!
					return OrderFill.failed();
				}
				// Fallback sell (Broken leg handler)
				return new OrderFill(
					new Amount(10),
					new Amount(100),
					new Amount(10),
					true,
				);
			},
			canExecuteBatch: (_count: number) => true,
		};

		const cycleExecutor = new CycleExecutor(
			() => mockExecutor as any,
			errorLogger,
			{} as any,
		);

		const pairBrlBtc = new Pair(new Currency("BTC"), new Currency("BRL"));
		const pairBtcEth = new Pair(new Currency("ETH"), new Currency("BTC"));
		const pairEthBrl = new Pair(new Currency("ETH"), new Currency("BRL"));

		const pairTuple = new PairTuple(pairBrlBtc, pairBtcEth);
		const pairs = new TriangularPairs(pairTuple, pairEthBrl);

		await cycleExecutor.executeCycle(pairs, new Amount(100));

		expect(saveSpy).toHaveBeenCalledTimes(1);

		// Verify the log entry has the correct details
		const savedEntry = saveSpy.mock.calls[0]?.[0];

		expect((savedEntry as any).errorType.asString()).toBe("BROKEN_LEG");
		expect((savedEntry as any).message.asString()).toContain("ETHBTC");
	});
});
