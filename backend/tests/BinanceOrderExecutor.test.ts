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

class MockPrecisionFetcher {
  getQuantityDecimals(symbol: string): number {
    if (symbol.includes("BTC")) return 5;
    if (symbol.includes("ETH")) return 4;
    return 0; // Meme coins
  }

  getPriceTickSize(symbol: string): number {
    if (symbol.includes("BTC")) return 0.01;
    if (symbol.includes("ETH")) return 0.01;
    return 0.0001; // Meme coins
  }
}

// Mock WebSocket Client
class MockWsClient extends BinanceWsClient {
  public ready = true;
  public simulateFailure = false;
  public simulateTimeout = false;
  public lastParams: any = null;
  public lastPlaceParams: any = null;
  
  constructor() {
    super("key", "secret");
  }

  public override isReady(): boolean {
    return this.ready;
  }
  
  public async ensureConnected(): Promise<void> {}
  
  public override async sendRequest(method: string, params: any, timeoutMs: number = 3000): Promise<WsResponse> {
    this.lastParams = params;
    if (method === "order.place") {
      this.lastPlaceParams = params;
    }
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
    const baseAsset = params.symbol ? params.symbol.replace(/USDT|BRL|BTC/, "") : "BTC";
    
    return {
      id: "mock-id",
      status: 200,
      result: {
        executedQty: "10.0",
        cummulativeQuoteQty: "50000.0",
        fills: [
          {
            price: "5000.0",
            qty: "10.0",
            commission: "0.01",
            commissionAsset: baseAsset
          }
        ]
      }
    };
  }
}

const mockStateManager: any = {
  retrieveOrderBook: (pair: Pair) => {
    return {
      getLatest: () => {
        return {
          getMidPrice: () => new Amount(100),
          applyTopAsk: (cb: any) => cb({ price: new Amount(101), quantity: new Amount(10) }),
          applyTopBid: (cb: any) => cb({ price: new Amount(99), quantity: new Amount(10) })
        }
      }
    }
  }
};

describe("BinanceOrderExecutor Logic Tests", () => {
  const pair = new Pair(new Currency("BTC"), new Currency("BRL"));
  const amount = new Amount(100);

  test("Rate Limiter - Should prevent execution if limit exceeded", async () => {
    const errRepo = new MockErrorLogRepository();
    const txRepo = new MockTransactionRepository();
    const precisionFetcher = new MockPrecisionFetcher();
    
    const mockClient = new MockWsClient();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, txRepo as any, precisionFetcher as any, mockStateManager as any);

    // Configure rate limiter to allow ONLY 4 requests (enough for 2 maker orders)
    const rateLimiter = new ExecutionRateLimiter(4, 10000); 
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    // 1st order - Should pass
    const fill1 = await executor.executeMakerBuy(pair, amount, undefined, 50);
    let success1 = fill1 !== null;
    expect(success1).toBe(true);

    // 2nd order - Should pass
    const fill2 = await executor.executeMakerBuy(pair, amount, undefined, 50);
    let success2 = fill2 !== null;
    expect(success2).toBe(true);

    // 3rd order - Should FAIL due to rate limit
    const fill3 = await executor.executeMakerBuy(pair, amount, undefined, 50);
    let success3 = fill3 !== null;
    expect(success3).toBe(false);

    // Check if error was logged
    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("RATE_LIMIT");
  });

  test("WebSocket Drops - Should fail gracefully when disconnected mid-execution", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    
    const rateLimiter = new ExecutionRateLimiter(50, 10000);
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    // Simulate connection drop
    mockClient.ready = false;

    const fill = await executor.executeMakerBuy(pair, amount, undefined);
    let success = fill !== null;
    
    expect(success).toBe(false);
    // Should not consume rate limit if not ready
    expect(rateLimiter.hasCapacityFor(50)).toBe(true);
  });

  test("Execution Error - Should fail gracefully on Binance rejection", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    
    mockClient.simulateFailure = true;
    const rateLimiter = new ExecutionRateLimiter(50, 10000);
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    const fill = await executor.executeMakerBuy(pair, amount, undefined);
    let success = fill !== null;
    
    expect(success).toBe(false);
    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("ORDER_REJECTED");
  });

  test("Timeout Tolerance - Should fail gracefully on timeout", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    
    mockClient.simulateTimeout = true;
    const rateLimiter = new ExecutionRateLimiter(50, 10000);
    executor.forceInjectWsClientForTests(mockClient, rateLimiter);

    const fill = await executor.executeMakerBuy(pair, amount, undefined);
    let success = fill !== null;
    
    expect(success).toBe(false);
    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("ORDER_EXCEPTION");
  });

  test("Precision - Should use 5 decimals for BTC quantity on Sell", async () => {
    const mockClient = new MockWsClient();
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, new MockErrorLogRepository() as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    executor.forceInjectWsClientForTests(mockClient, new ExecutionRateLimiter(50, 10000));

    const btcPair = new Pair(new Currency("BTC"), new Currency("USDT"));
    await executor.executeMakerSell(btcPair, new Amount(1.12345678), undefined, 0);

    expect(mockClient.lastPlaceParams.quantity).toBe("1.12345");
  });

  test("Precision - Should use 4 decimals for ETH quantity on Sell", async () => {
    const mockClient = new MockWsClient();
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, new MockErrorLogRepository() as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    executor.forceInjectWsClientForTests(mockClient, new ExecutionRateLimiter(50, 10000));

    const ethPair = new Pair(new Currency("ETH"), new Currency("USDT"));
    await executor.executeMakerSell(ethPair, new Amount(1.12345678), undefined, 0);

    expect(mockClient.lastPlaceParams.quantity).toBe("1.1234");
  });

  test("Precision - Should use 0 decimals for MEME quantity on Sell", async () => {
    const mockClient = new MockWsClient();
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, new MockErrorLogRepository() as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    executor.forceInjectWsClientForTests(mockClient, new ExecutionRateLimiter(50, 10000));

    const pepePair = new Pair(new Currency("PEPE"), new Currency("USDT"));
    await executor.executeMakerSell(pepePair, new Amount(15.403), undefined);

    expect(mockClient.lastPlaceParams.quantity).toBe("15");
  });

  test("Execution Error - Should log ORDER_TRUNCATED_TO_ZERO if quantity is too small", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    executor.forceInjectWsClientForTests(mockClient, new ExecutionRateLimiter(50, 10000));

    // Try to buy with an extremely small amount of quote currency
    await executor.executeMakerBuy(pair, new Amount(0.0001), undefined, 50);

    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("ORDER_TRUNCATED_TO_ZERO");
  });

  test("Execution Error - Should retry and then log ORDER_REJECTED_INSUFFICIENT_FUNDS for -2010", async () => {
    const errRepo = new MockErrorLogRepository();
    const mockClient = new MockWsClient();
    // Simulate -2010 error
    mockClient.sendRequest = async (method: string, params: any) => {
      return {
        id: "mock-id",
        status: 400,
        result: {},
        error: { code: -2010, msg: "Account has insufficient balance for requested action." }
      };
    };
    
    const precisionFetcher = new MockPrecisionFetcher();
    const executor = new BinanceOrderExecutor(mockClient, errRepo as any, new MockTransactionRepository() as any, precisionFetcher as any, mockStateManager as any);
    executor.forceInjectWsClientForTests(mockClient, new ExecutionRateLimiter(50, 10000));

    const fill = await executor.executeMakerBuy(pair, amount, undefined);
    let success = fill !== null;
    
    expect(success).toBe(false);
    expect(errRepo.errors.length).toBe(1);
    expect(errRepo.errors[0].errorType.value).toBe("ORDER_REJECTED");
  });
});
