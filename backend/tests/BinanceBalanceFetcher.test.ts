import { describe, expect, it } from "bun:test";
import { BinanceBalanceFetcher } from "../src/infrastructure/BinanceBalanceFetcher";

// Mock para o BinanceWsClient
class MockWsClient {
	public ready = true;
	public mockResponse: any = null;

	isReady() {
		return this.ready;
	}

	async sendRequest(_method: string, _params: any) {
		if (this.mockResponse) {
			return this.mockResponse;
		}
		return { status: 500, error: "Mock error" };
	}
}

describe("BinanceBalanceFetcher", () => {
	it("should return zero balances if wsClient is not ready", async () => {
		const mockClient = new MockWsClient();
		mockClient.ready = false;

		const fetcher = new BinanceBalanceFetcher(mockClient as any);
		const balances = await fetcher.fetchBalances();

		expect((balances.brl as any).value).toBe(0);
		expect((balances.bnb as any).value).toBe(0);
	});

	it("should parse and return BRL and BNB balances correctly", async () => {
		const mockClient = new MockWsClient();
		mockClient.mockResponse = {
			status: 200,
			result: {
				balances: [
					{ asset: "BTC", free: "0.5" },
					{ asset: "BRL", free: "950.45" },
					{ asset: "BNB", free: "2.5" },
				],
			},
		};

		const fetcher = new BinanceBalanceFetcher(mockClient as any);
		const balances = await fetcher.fetchBalances();

		expect((balances.brl as any).value).toBe(950.45);
		expect((balances.bnb as any).value).toBe(2.5);
	});

	it("should return zero for missing assets in response", async () => {
		const mockClient = new MockWsClient();
		mockClient.mockResponse = {
			status: 200,
			result: {
				balances: [{ asset: "BTC", free: "0.5" }],
			},
		};

		const fetcher = new BinanceBalanceFetcher(mockClient as any);
		const balances = await fetcher.fetchBalances();

		expect((balances.brl as any).value).toBe(0);
		expect((balances.bnb as any).value).toBe(0);
	});

	it("should return zero on API errors and not crash", async () => {
		const mockClient = new MockWsClient();
		mockClient.mockResponse = {
			status: 400,
			error: "Bad Request",
		};

		const fetcher = new BinanceBalanceFetcher(mockClient as any);
		const balances = await fetcher.fetchBalances();

		expect((balances.brl as any).value).toBe(0);
		expect((balances.bnb as any).value).toBe(0);
	});
});
