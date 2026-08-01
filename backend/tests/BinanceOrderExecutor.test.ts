import { test, expect, describe, mock } from "bun:test";
import { BinanceOrderExecutor } from "../src/infrastructure/BinanceOrderExecutor";
import { BinanceWsClient, WsResponse, WsRequest } from "../src/infrastructure/BinanceWsClient";
import { ExecutionRateLimiter } from "../src/infrastructure/ExecutionRateLimiter";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Amount } from "../src/domain/valueObjects/Amount";
import { OrderFill } from "../src/domain/valueObjects/OrderFill";

// Mock Repositories
class MockErrorLogRepository {
  public errors: any[] = [];
  save(entry: any) {
    this.errors.push(entry);
  }
}

class MockTransactionRepository {
  save(entry: any) {}
}

// Mock WebSocket Client
class MockWsClient extends BinanceWsClient {
  public ready = true;
  public simulateFailure = false;
  public simulateTimeout = false;
  
  constructor() {
    super("key", "secret");
  }
  
  public override isReady(): boolean {
    return this.ready;
  }
  
  public override async ensureConnected(): Promise<void> {}
  
  public override async sendRequest(method: string, params: any, timeoutMs: number = 3000): Promise<WsResponse> {
    if (!this.ready) {
      throw new Error("Socket disconnected");
    }
    if (this.simulateTimeout) {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timeout")), 50);
      });
    }
    if (this.simulateFailure) {
      return {
        id: "mock-id",
        status: 400,
        result: {},
        error: { code: -1013, msg: "Filter failure: LOT_SIZE" }
      };
    }
    return {
      id: "mock-id",
      status: 200,
      result: {
        executedQty: "10.0",
        cummulativeQuoteQty: "50000.0"
      }
    };
  }
}

describe("BinanceOrderExecutor Logic Tests", () => {
  const pair = new Pair(new Currency("BTC"), new Currency("BRL"));
  const amount = new Amount(100);

  test("Rate Limiter - Should prevent execution if limit exceeded", async () => {
    const errRepo = new MockErrorLogRepository();
    const txRepo = new MockTransactionRepository();
    
    const mockClient = new MockWsClient();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, txRepo as any);

    // Configure rate limiter to allow ONLY 2 orders
    const rateLimiter = new ExecutionRateLimiter(2, 10000); 
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    // 1st order - Should pass
    const fill1 = await executor.executeMarketBuy(pair, amount);
    let success1 = false; fill1.apply((q, qq, p, s) => { success1 = s; });
    expect(success1).toBe(true);

    // 2nd order - Should pass
    const fill2 = await executor.executeMarketBuy(pair, amount);
    let success2 = false; fill2.apply((q, qq, p, s) => { success2 = s; });
    expect(success2).toBe(true);

    // 3rd order - Should FAIL due to rate limit
    const fill3 = await executor.executeMarketBuy(pair, amount);
    let success3 = false; fill3.apply((q, qq, p, s) => { success3 = s; });
    expect(success3).toBe(false);

    // Check if error was logged
    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("RATE_LIMIT");
  });

  test("WebSocket Drops - Should fail gracefully when disconnected mid-execution", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any);
    
    const rateLimiter = new ExecutionRateLimiter(50, 10000);
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    // Simulate connection drop
    mockClient.ready = false;

    const fill = await executor.executeMarketBuy(pair, amount);
    let success = false; fill.apply((q, qq, p, s) => { success = s; });
    
    expect(success).toBe(false);
    // Should not consume rate limit if not ready
    expect(rateLimiter.hasCapacityFor(50)).toBe(true);
  });

  test("Execution Error - Should fail gracefully on Binance rejection", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any);
    
    mockClient.simulateFailure = true;
    const rateLimiter = new ExecutionRateLimiter(50, 10000);
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    const fill = await executor.executeMarketBuy(pair, amount);
    let success = false; fill.apply((q, qq, p, s) => { success = s; });
    
    expect(success).toBe(false);
    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("ORDER_REJECTED");
  });

  test("Timeout Tolerance - Should fail gracefully on timeout", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any);
    
    mockClient.simulateTimeout = true;
    const rateLimiter = new ExecutionRateLimiter(50, 10000);
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    const fill = await executor.executeMarketBuy(pair, amount);
    let success = false; fill.apply((q, qq, p, s) => { success = s; });
    
    expect(success).toBe(false);
    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("ORDER_FAILED");
  });
});
