import { describe, expect, it, mock } from "bun:test";
import { TransactionRepository, TransactionLogEntry, LogId, Timestamp, TradeId, AssetName, MonetaryValue, TradeStatus } from "../src/infrastructure/database/TransactionRepository";
import { AsyncDatabaseWriter, DatabaseQuery } from "../src/infrastructure/database/AsyncDatabaseWriter";

describe("TransactionRepository", () => {
    it("should convert TransactionLogEntry to DatabaseQuery correctly", () => {
        const entry = new TransactionLogEntry(
            new LogId("log-123"),
            new Timestamp(1620000000000),
            new TradeId("trade-456"),
            new AssetName("BTC"),
            new MonetaryValue(1.5),
            new MonetaryValue(60000),
            new MonetaryValue(100),
            new TradeStatus("COMPLETED")
        );

        const query = entry.toQuery();
        
        let executedSql = "";
        let executedParams: any[] = [];
        
        const mockDb = {
            run: mock((sql: string, params: any[]) => {
                executedSql = sql;
                executedParams = params;
            })
        } as any;
        
        query.executeOn(mockDb);
        
        expect(executedSql).toContain("INSERT INTO transaction_logs");
        
        expect(executedParams).toEqual([
            "log-123",
            1620000000000,
            "trade-456",
            "BTC",
            1.5,
            60000,
            100,
            "COMPLETED"
        ]);
    });

    it("should enqueue query when save is called", () => {
        const mockWriter = {
            enqueue: mock((query: DatabaseQuery) => {})
        } as unknown as AsyncDatabaseWriter;

        const repo = new TransactionRepository(mockWriter);
        
        const entry = new TransactionLogEntry(
            new LogId("1"),
            new Timestamp(1),
            new TradeId("1"),
            new AssetName("A"),
            new MonetaryValue(1),
            new MonetaryValue(1),
            new MonetaryValue(1),
            new TradeStatus("1")
        );

        repo.save(entry);
        expect(mockWriter.enqueue).toHaveBeenCalledTimes(1);
    });
});
