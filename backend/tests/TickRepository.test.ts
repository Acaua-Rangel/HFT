import { describe, expect, mock, test } from "bun:test";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Tick } from "../src/domain/valueObjects/Tick";
import type {
	AsyncDatabaseWriter,
	DatabaseQuery,
} from "../src/infrastructure/database/AsyncDatabaseWriter";
import { TickRepository } from "../src/infrastructure/database/TickRepository";

describe("TickRepository", () => {
	test("should convert Tick to TickLogEntry and enqueue query", () => {
		const mockWriter = {
			enqueue: mock((_query: DatabaseQuery) => {}),
		} as unknown as AsyncDatabaseWriter;

		const repo = new TickRepository(mockWriter);

		const pair = new Pair(new Currency("BTC"), new Currency("USDT"));
		const tick = new Tick(
			pair,
			[{ price: new Amount(60000), qty: new Amount(1.5) }],
			[{ price: new Amount(59990), qty: new Amount(2.0) }],
		);

		repo.saveTick(tick);

		expect(mockWriter.enqueue).toHaveBeenCalled();
	});

	test("should handle missing bids/asks gracefully", () => {
		const mockWriter = {
			enqueue: mock((_query: DatabaseQuery) => {}),
		} as unknown as AsyncDatabaseWriter;

		const repo = new TickRepository(mockWriter);
		const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

		// Empty bids/asks
		const tick = new Tick(pair, [], []);

		repo.saveTick(tick);

		expect(mockWriter.enqueue).toHaveBeenCalled();
	});
});
