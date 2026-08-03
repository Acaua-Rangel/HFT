import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Pair } from "../src/domain/valueObjects/Pair";
import { BinanceFeeFetcher } from "../src/infrastructure/BinanceFeeFetcher";

describe("BinanceFeeFetcher", () => {
	let globalFetch: any;

	beforeEach(() => {
		globalFetch = global.fetch;
	});

	afterEach(() => {
		global.fetch = globalFetch;
	});

	it("should fetch and cache fees correctly", async () => {
		global.fetch = mock(async (_url: string) => {
			return {
				ok: true,
				json: async () => [
					{
						symbol: "BTCUSDT",
						takerCommission: "0.001",
						makerCommission: "0.001",
					},
					{
						symbol: "ETHUSDT",
						takerCommission: "0.0015",
						makerCommission: "0.0015",
					},
				],
			};
		}) as any;

		const fetcher = new BinanceFeeFetcher();
		const btcUsdt = new Pair(new Currency("BTC"), new Currency("USDT"));
		const ethUsdt = new Pair(new Currency("ETH"), new Currency("USDT"));

		await fetcher.preloadFees([btcUsdt, ethUsdt]);

		const btcFee = fetcher.getFeeFor(btcUsdt);
		let btcFeeVal = 0;
		btcFee.percentage.apply((v) => (btcFeeVal = v));
		expect(btcFeeVal).toBe(0.001);

		const ethFee = fetcher.getFeeFor(ethUsdt);
		let ethFeeVal = 0;
		ethFee.percentage.apply((v) => (ethFeeVal = v));
		expect(ethFeeVal).toBe(0.0015);
	});

	it("should fallback to 0.1% if symbol not found", async () => {
		global.fetch = mock(async (_url: string) => {
			return {
				ok: true,
				json: async () => [], // empty
			};
		}) as any;

		const fetcher = new BinanceFeeFetcher();
		const btcUsdt = new Pair(new Currency("BTC"), new Currency("USDT"));

		await fetcher.preloadFees([btcUsdt]);

		const btcFee = fetcher.getFeeFor(btcUsdt);
		let btcFeeVal = 0;
		btcFee.percentage.apply((v) => (btcFeeVal = v));
		expect(btcFeeVal).toBe(0.001); // 0.1% fallback
	});
});
