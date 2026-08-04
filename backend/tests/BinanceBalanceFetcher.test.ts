import { describe, it, expect } from "bun:test";
import { BinanceBalanceFetcher } from "../src/infrastructure/BinanceBalanceFetcher";
import { Amount } from "../src/domain/valueObjects/Amount";

// Mock para o BinanceWsClient
class MockWsClient {
  public ready = true;
  public mockResponse: any = null;

  isReady() {
    return this.ready;
  }

  async sendRequest(method: string, params: any) {
    if (this.mockResponse) {
      return this.mockResponse;
    }
    return { status: 500, error: "Mock error" };
  }
}

describe("BinanceBalanceFetcher", () => {
  it("should return empty map if wsClient is not ready", async () => {
    const mockClient = new MockWsClient();
    mockClient.ready = false;
    
    const fetcher = new BinanceBalanceFetcher(mockClient as any);
    const balances = await fetcher.fetchBalances();
    
    expect(balances.size).toBe(0);
  });

  it("should parse and return balances correctly as Map", async () => {
    const mockClient = new MockWsClient();
    mockClient.mockResponse = {
      status: 200,
      result: {
        balances: [
          { asset: "BTC", free: "0.5" },
          { asset: "BRL", free: "950.45" },
          { asset: "BNB", free: "2.5" },
          { asset: "FDUSD", free: "0" } // Should be ignored because 0
        ]
      }
    };
    
    const fetcher = new BinanceBalanceFetcher(mockClient as any);
    const balances = await fetcher.fetchBalances();
    
    expect(balances.has("BTC")).toBe(true);
    expect((balances.get("BTC") as any).value).toBe(0.5);
    
    expect(balances.has("BRL")).toBe(true);
    expect((balances.get("BRL") as any).value).toBe(950.45);
    
    expect(balances.has("BNB")).toBe(true);
    expect((balances.get("BNB") as any).value).toBe(2.5);
    
    expect(balances.has("FDUSD")).toBe(false);
  });

  it("should return empty map on API errors and not crash", async () => {
    const mockClient = new MockWsClient();
    mockClient.mockResponse = {
      status: 400,
      error: "Bad Request"
    };
    
    const fetcher = new BinanceBalanceFetcher(mockClient as any);
    const balances = await fetcher.fetchBalances();
    
    expect(balances.size).toBe(0);
  });
});
