import { describe, expect, it, mock } from "bun:test";
import { SimulationOrderExecutor } from "../src/infrastructure/SimulationOrderExecutor";
import { ErrorLogRepository } from "../src/infrastructure/database/ErrorLogRepository";
import { TransactionRepository } from "../src/infrastructure/database/TransactionRepository";
import { BinancePrecisionFetcher } from "../src/infrastructure/BinancePrecisionFetcher";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Amount } from "../src/domain/valueObjects/Amount";

describe("SimulationOrderExecutor", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

    it("should set and return balances", () => {
        const errorRepo = { log: async () => {} } as unknown as ErrorLogRepository;
        const txRepo = { save: async () => {} } as unknown as TransactionRepository;
        const precisionFetcher = { getPrecision: () => ({ basePrecision: 5, quotePrecision: 2, tickSize: 2 }) } as unknown as BinancePrecisionFetcher;
        const stateManager = new LocalStateManager();
        
        const executor = new SimulationOrderExecutor(errorRepo, txRepo, precisionFetcher, stateManager);
        
        executor.setInitialBalances(2, 10000);
        
        expect(executor.baseBalance).toBe(2);
        expect(executor.quoteBalance).toBe(10000);
    });

    it("should allow batch execution", () => {
        const executor = new SimulationOrderExecutor(
            {} as any, {} as any, {} as any, {} as any
        );
        expect(executor.canExecuteBatch(10)).toBeTrue();
    });
});
