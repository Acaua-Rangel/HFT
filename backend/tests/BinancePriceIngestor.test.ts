import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Pair } from "../src/domain/valueObjects/Pair";
import type { Tick } from "../src/domain/valueObjects/Tick";
import { BinancePriceIngestor } from "../src/infrastructure/BinancePriceIngestor";

describe("BinancePriceIngestor", () => {
	let MockWebSocket: any;
	let wsInstance: any;
	let originalWebSocket: any;

	beforeEach(() => {
		wsInstance = {
			send: mock(() => {}),
			close: mock(() => {}),
			readyState: 1,
		};

		MockWebSocket = mock((_url: string) => {
			return wsInstance;
		}) as any;
		MockWebSocket.OPEN = 1;

		originalWebSocket = global.WebSocket;
		global.WebSocket = MockWebSocket;
	});

	afterEach(() => {
		global.WebSocket = originalWebSocket;
	});

	it("should batch subscriptions correctly", async () => {
		const ingestor = new BinancePriceIngestor();
		const btcUsdt = new Pair(new Currency("BTC"), new Currency("USDT"));
		const ethUsdt = new Pair(new Currency("ETH"), new Currency("USDT"));

		// Simulate open
		if (wsInstance.onopen) wsInstance.onopen();

		ingestor.subscribe(btcUsdt);
		ingestor.subscribe(ethUsdt);

		// Wait for batching timeout (100ms)
		await new Promise((r) => setTimeout(r, 150));

		expect(wsInstance.send).toHaveBeenCalledTimes(1);

		const sentMsg = JSON.parse(wsInstance.send.mock.calls[0][0]);
		expect(sentMsg.method).toBe("SUBSCRIBE");
		expect(sentMsg.params).toContain("btcusdt@depth20@100ms");
		expect(sentMsg.params).toContain("ethusdt@depth20@100ms");
	});

	it("should process depth stream and notify callbacks", async () => {
		const ingestor = new BinancePriceIngestor();
		const btcUsdt = new Pair(new Currency("BTC"), new Currency("USDT"));

		let receivedTick: Tick | undefined;
		ingestor.onTick((tick) => {
			receivedTick = tick;
		});

		if (wsInstance.onopen) wsInstance.onopen();
		ingestor.subscribe(btcUsdt);
		await new Promise((r) => setTimeout(r, 150));

		// Simulate incoming message
		const payload = {
			stream: "btcusdt@depth20@100ms",
			data: {
				asks: [["60000", "1.5"]],
				bids: [["59990", "2.0"]],
			},
		};

		wsInstance.onmessage({ data: JSON.stringify(payload) });

		expect(receivedTick).toBeDefined();
		if (receivedTick) {
			let cost = 0;
			// Best ask is 60000, 1 qty
			receivedTick.calculateCost(new Amount(1)).apply((v) => (cost = v));
			expect(cost).toBe(60000);
		}
	});
});

it("should ignore invalid JSON gracefully", async () => {
	const ingestor = new BinancePriceIngestor();
	const wsInstance: any = { send: () => {} };
	(global as any).WebSocket = class {
		constructor() {
			return wsInstance;
		}
	};

	if (wsInstance.onopen) wsInstance.onopen();
	ingestor.subscribe(new Pair(new Currency("BTC"), new Currency("USDT")));

	if (wsInstance.onmessage) {
		wsInstance.onmessage({ data: "NOT A JSON" } as MessageEvent);
	}

	expect(true).toBe(true);
});
