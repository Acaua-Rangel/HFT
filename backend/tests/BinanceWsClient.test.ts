import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { BinanceWsClient } from "../src/infrastructure/BinanceWsClient";

describe("BinanceWsClient", () => {
    let client: BinanceWsClient;
    
    // Mock the global WebSocket object for testing
    let MockWebSocket: any;
    let wsInstance: any;

    beforeEach(() => {
        wsInstance = {
            send: mock(() => {}),
            close: mock(() => {}),
            readyState: 1 // WebSocket.OPEN
        };

        MockWebSocket = mock((url: string) => {
            return wsInstance;
        }) as any;
        MockWebSocket.OPEN = 1;

        global.WebSocket = MockWebSocket;
        client = new BinanceWsClient("key", "secret");
    });

    afterEach(() => {
        client.disconnect();
        delete (global as any).WebSocket;
    });

    it("should connect, resolve promise and set state when opened", async () => {
        const connectPromise = client.connect();
        expect(MockWebSocket).toHaveBeenCalledTimes(1);

        // Simulate WebSocket open
        wsInstance.onopen();
        
        await connectPromise;

        expect(client.isReady()).toBe(true);
    });

    it("should reject connect promise on error", async () => {
        const connectPromise = client.connect();
        
        // Simulate WebSocket error before open
        wsInstance.onerror(new Error("Connection failed"));
        
        expect(connectPromise).rejects.toThrow("Connection failed");
    });

    it("should disconnect properly", async () => {
        client.connect();
        client.disconnect();
        expect(wsInstance.close).toHaveBeenCalledTimes(1);
    });

    it("should reject all pending requests on close", async () => {
        const connectPromise = client.connect();
        wsInstance.onopen();
        await connectPromise;

        const reqPromise = client.sendRequest("testMethod", {});
        
        // Simulate WebSocket close
        wsInstance.onclose();
        
        expect(reqPromise).rejects.toThrow("WebSocket disconnected unexpectedly");
        expect(client.isReady()).toBe(false);
    });

    it("should parse incoming messages and resolve pending requests", async () => {
        const connectPromise = client.connect();
        wsInstance.onopen();
        await connectPromise;

        const reqPromise = client.sendRequest("testMethod", {});

        // Since we don't know the generated ID easily from outside, we can hack it by intercepting send
        let sentMessage: any;
        expect(wsInstance.send).toHaveBeenCalled();
        wsInstance.send.mock.calls.forEach((args: any[]) => {
            sentMessage = JSON.parse(args[0]);
        });

        // Simulate incoming response
        const mockResponse = {
            id: sentMessage.id,
            status: 200,
            result: "success"
        };
        wsInstance.onmessage({ data: JSON.stringify(mockResponse) });

        const result = await reqPromise;
        expect(result.result).toBe("success");
    });
});
