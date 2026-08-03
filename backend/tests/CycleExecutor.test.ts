import { describe, expect, it, mock } from "bun:test";
import { CycleExecutor } from "../src/application/CycleExecutor";
import { PairTuple, TriangularPairs } from "../src/application/TriangularPairs";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";
import { OrderFill } from "../src/domain/valueObjects/OrderFill";
import { Pair } from "../src/domain/valueObjects/Pair";
import type { ErrorLogRepository } from "../src/infrastructure/database/ErrorLogRepository";

describe("CycleExecutor Edge Cases", () => {
	it("should handle error in executeTrade and log execution error", async () => {
		const mockExecutor = {
			executeMarketBuy: async (_pair: Pair, amount: Amount) => {
				return new OrderFill(amount, amount, new Amount(1), true);
			},
			executeMarketSell: async (_pair: Pair, _amount: Amount) => {
				throw new Error("Simulated network drop");
			},
			canExecuteBatch: (_count: number) => true,
		};

		const saveSpy = mock((_entry: any) => {});
		const mockErrorLogger = {
			save: saveSpy,
		} as unknown as ErrorLogRepository;

		const cycleExecutor = new CycleExecutor(
			() => mockExecutor as any,
			mockErrorLogger,
			{} as any,
		);

		const pairBrlBtc = new Pair(new Currency("BTC"), new Currency("BRL"));
		const pairBtcEth = new Pair(new Currency("ETH"), new Currency("BTC"));
		const pairEthBrl = new Pair(new Currency("ETH"), new Currency("BRL"));

		const pairTuple = new PairTuple(pairBrlBtc, pairBtcEth);
		const pairs = new TriangularPairs(pairTuple, pairEthBrl);

		const result = await cycleExecutor.executeCycle(pairs, new Amount(100));

		expect(saveSpy).toHaveBeenCalled();
		let successFlag = true;
		result.apply((_qty, _quote, _price, success) => {
			successFlag = success;
		});
		expect(successFlag).toBe(false);
	});

	it("should return early if canExecuteBatch fails", async () => {
		const mockExecutor = {
			canExecuteBatch: (_count: number) => false, // Limit exceeded!
		};

		const cycleExecutor = new CycleExecutor(
			() => mockExecutor as any,
			{} as any,
			{} as any,
		);

		const pairs = new TriangularPairs(
			new PairTuple(
				new Pair(new Currency("BTC"), new Currency("BRL")),
				new Pair(new Currency("ETH"), new Currency("BTC")),
			),
			new Pair(new Currency("ETH"), new Currency("BRL")),
		);

		const result = await cycleExecutor.executeCycle(pairs, new Amount(100));

		let successFlag = true;
		result.apply((_qty, _quote, _price, success) => (successFlag = success));
		expect(successFlag).toBe(false);
	});
});
