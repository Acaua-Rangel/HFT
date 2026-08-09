import { expect, test, describe, beforeEach, mock } from "bun:test";
import { ErrorLogRepository, ErrorLogEntry, ErrorType, ErrorMessage, StackTrace, ErrorContext } from "../src/infrastructure/database/ErrorLogRepository";
import { LogId, Timestamp } from "../src/infrastructure/database/TransactionRepository";

class MockAsyncDatabaseWriter {
    public enqueuedQueries: any[] = [];
    public enqueue(query: any) {
        this.enqueuedQueries.push(query);
    }
}

describe("ErrorLogRepository", () => {
    let mockWriter: MockAsyncDatabaseWriter;
    let repo: ErrorLogRepository;

    beforeEach(() => {
        mockWriter = new MockAsyncDatabaseWriter();
        repo = new ErrorLogRepository(mockWriter as any);
    });

    test("should enqueue a valid database query when save is called", () => {
        const id = { asString: () => "uuid-123" } as LogId;
        const ts = { asNumber: () => 1620000000000 } as Timestamp;
        const type = new ErrorType("NETWORK_ERROR");
        const message = new ErrorMessage("Timeout");
        const stack = new StackTrace("Error at line 1");
        const context = new ErrorContext("{}");

        const entry = new ErrorLogEntry(id, ts, type, message, stack, context);

        repo.save(entry);

        expect(mockWriter.enqueuedQueries.length).toBe(1);
        const query = mockWriter.enqueuedQueries[0];
        
        const executed: any[] = [];
        const mockDb = {
            run: (sql: string, params: any[]) => executed.push({ sql, params })
        };
        
        query.executeOn(mockDb as any);
        
        expect(executed.length).toBe(1);
        expect(executed[0].sql).toContain("INSERT INTO error_logs");
        expect(executed[0].params).toEqual([
            "uuid-123",
            1620000000000,
            "NETWORK_ERROR",
            "Timeout",
            "Error at line 1",
            "{}"
        ]);
    });
});
