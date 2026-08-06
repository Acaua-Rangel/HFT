import { expect, test, describe, beforeEach, afterEach, mock } from "bun:test";
import { 
    AsyncDatabaseWriter, 
    QueryQueue, 
    ProcessingState, 
    DatabaseQuery, 
    SqlStatement, 
    QueryParameters 
} from "../src/infrastructure/database/AsyncDatabaseWriter";

// Create a mock db
class MockDb {
    public executedQueries: any[] = [];
    public runError: boolean = false;

    run(query: string, params: any[]) {
        if (this.runError) {
            throw new Error("DB Run Error");
        }
        this.executedQueries.push({ query, params });
    }

    transaction(cb: (queries: DatabaseQuery[]) => void) {
        return (batch: DatabaseQuery[]) => {
            cb(batch);
        };
    }
}

describe("AsyncDatabaseWriter", () => {
    let mockDb: MockDb;
    let queue: QueryQueue;
    let state: ProcessingState;
    let writer: AsyncDatabaseWriter;

    beforeEach(() => {
        mockDb = new MockDb();
        queue = new QueryQueue();
        state = new ProcessingState();
        writer = new AsyncDatabaseWriter(mockDb as any, queue, state);
    });

    test("should enqueue queries and process them asynchronously", async () => {
        const q1 = new DatabaseQuery(new SqlStatement("INSERT INTO test VALUES (?)"), new QueryParameters([1]));
        const q2 = new DatabaseQuery(new SqlStatement("INSERT INTO test VALUES (?)"), new QueryParameters([2]));
        
        writer.enqueue(q1);
        writer.enqueue(q2);

        // Wait for setImmediate to execute
        await new Promise(r => setTimeout(r, 10));

        expect(mockDb.executedQueries.length).toBe(2);
        expect(mockDb.executedQueries[0].query).toBe("INSERT INTO test VALUES (?)");
        expect(mockDb.executedQueries[0].params[0]).toBe(1);
        expect(mockDb.executedQueries[1].params[0]).toBe(2);
        
        // State should be deactivated
        expect(state["active"]).toBe(false);
    });

    test("should deactivate if queue is empty", async () => {
        writer["scheduleProcessing"](); // Force processing directly
        await new Promise(r => setTimeout(r, 10));
        
        expect(state["active"]).toBe(false);
    });
});

describe("SqlStatement and QueryParameters", () => {
    test("SqlStatement asString", () => {
        const stmt = new SqlStatement("SELECT 1");
        expect(stmt.asString()).toBe("SELECT 1");
    });
    
    test("QueryParameters asArray", () => {
        const params = new QueryParameters([1, 2, 3]);
        expect(params.asArray()).toEqual([1, 2, 3]);
    });
});

describe("QueryQueue", () => {
    test("add and takeBatch", () => {
        const q = new QueryQueue();
        expect(q.hasItems()).toBe(false);
        q.add({} as DatabaseQuery);
        expect(q.hasItems()).toBe(true);
        const batch = q.takeBatch();
        expect(batch.length).toBe(1);
        expect(q.hasItems()).toBe(false);
    });
});

describe("ProcessingState", () => {
    test("executeIfInactive activates and executes", () => {
        const s = new ProcessingState();
        let executed = false;
        s.executeIfInactive(() => executed = true);
        expect(executed).toBe(true);
        
        // Cannot execute again if active
        executed = false;
        s.executeIfInactive(() => executed = true);
        expect(executed).toBe(false);
        
        s.deactivate();
        s.executeIfInactive(() => executed = true);
        expect(executed).toBe(true);
    });
});
