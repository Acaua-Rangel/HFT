import { describe, it, expect, mock } from "bun:test";
import { BinanceOrderExecutor } from "../src/infrastructure/BinanceOrderExecutor";
import { ErrorLogRepository } from "../src/infrastructure/database/ErrorLogRepository";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Amount } from "../src/domain/valueObjects/Amount";
import { AsyncDatabaseWriter, QueryQueue, ProcessingState } from "../src/infrastructure/database/AsyncDatabaseWriter";
import { Database } from "bun:sqlite";

describe("Broken Leg Scenario (Risk protection)", () => {
  it("should trigger circuit breaker and log broken leg event for 3rd leg (ETH->BRL) timeout or error", async () => {
    // Setup in-memory mock DB
    const db = new Database(":memory:");
    db.run("CREATE TABLE error_logs (id TEXT, timestamp INTEGER, error_type TEXT, message TEXT, stack_trace TEXT, context TEXT)");

    const queue = new QueryQueue();
    const state = new ProcessingState();
    const writer = new AsyncDatabaseWriter(db, queue, state);
    const errorLogger = new ErrorLogRepository(writer);
    
    // Spy on save method
    const saveSpy = mock(errorLogger.save.bind(errorLogger));
    errorLogger.save = saveSpy as any;

    const executor = new BinanceOrderExecutor(errorLogger);
    
    const pairBrlBtc = new Pair(new Currency("BTC"), new Currency("BRL"));
    const pairBtcEth = new Pair(new Currency("ETH"), new Currency("BTC"));
    const pairEthBrl = new Pair(new Currency("ETH"), new Currency("BRL"));

    // 1st Leg (Buy BTC with BRL) -> Success expected
    executor.executeMarketBuy(pairBrlBtc, new Amount(100));
    
    // 2nd Leg (Buy ETH with BTC) -> Success expected
    executor.executeMarketBuy(pairBtcEth, new Amount(0.01));

    // 3rd Leg (Sell ETH for BRL) with Timeout -> Should mock failure!
    executor.executeMarketSellWithTimeout(pairEthBrl, new Amount(0.2), 100);

    // Wait some time to let promise/timeout resolve
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(saveSpy).toHaveBeenCalledTimes(1);
    
    // Verify the log entry has the correct details
    const savedEntry = saveSpy.mock.calls[0][0];
    
    expect((savedEntry as any).errorType.asString()).toBe("BROKEN_LEG");
    expect((savedEntry as any).message.asString()).toContain("ETH-BRL");
  });
});
