import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { BinancePriceIngestor } from "../src/infrastructure/BinancePriceIngestor";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Tick } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";

describe("BinancePriceIngestor", () => {
    let MockWebSocket: any;
    let wsInstance: any;

    beforeEach(() => {
        wsInstance = {
            send: mock(() => {}),
            close: mock(() => {}),
            readyState: 1
        };

        MockWebSocket = mock((url: string) => {
            return wsInstance;
        }) as any;
        MockWebSocket.OPEN = 1;

        global.WebSocket = MockWebSocket;
    });

    afterEach(() => {
        delete (global as any).WebSocket;
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
        await new Promise(r => setTimeout(r, 150));

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
        await new Promise(r => setTimeout(r, 150));

        // Simulate incoming message
        const payload = {
            stream: "btcusdt@depth20@100ms",
            data: {
                asks: [["60000", "1.5"]],
                bids: [["59990", "2.0"]]
            }
        };

        wsInstance.onmessage({ data: JSON.stringify(payload) });

        expect(receivedTick).toBeDefined();
        if (receivedTick) {
            let cost = 0;
            // Best ask is 60000, 1 qty
            receivedTick.calculateCost(new Amount(1)).apply(v => cost = v);
            expect(cost).toBe(60000);
        }
    });
});
