import { Database } from "bun:sqlite";

export class SqlStatement {
    constructor(private readonly value: string) {}

    public asString(): string {
        return this.value;
    }
}

export class QueryParameters {
    constructor(private readonly values: unknown[]) {}

    public asArray(): unknown[] {
        return this.values;
    }
}

export class DatabaseQuery {
    constructor(
        private readonly statement: SqlStatement,
        private readonly parameters: QueryParameters
    ) {}

    public executeOn(database: Database): void {
        database.run(this.statement.asString(), this.parameters.asArray());
    }
}

export class QueryQueue {
    private readonly items: DatabaseQuery[] = [];

    public add(query: DatabaseQuery): void {
        this.items.push(query);
    }

    public hasItems(): boolean {
        return this.items.length > 0;
    }

    public takeBatch(): DatabaseQuery[] {
        return this.items.splice(0, 50);
    }
}

export class ProcessingState {
    private active: boolean = false;

    public executeIfInactive(action: () => void): void {
        if (!this.active) {
            this.active = true;
            action();
        }
    }

    public deactivate(): void {
        this.active = false;
    }
}

export class AsyncDatabaseWriter {
    constructor(
        private readonly database: Database,
        private readonly queue: QueryQueue,
        private readonly state: ProcessingState
    ) {}

    public enqueue(query: DatabaseQuery): void {
        this.queue.add(query);
        this.scheduleProcessing();
    }

    private scheduleProcessing(): void {
        this.state.executeIfInactive(() => {
            setImmediate(() => this.processBatch());
        });
    }

    private processBatch(): void {
        if (!this.queue.hasItems()) {
            this.state.deactivate();
            return;
        }

        const batch = this.queue.takeBatch();
        this.executeBatch(batch);
        
        setImmediate(() => this.processBatch());
    }

    private executeBatch(batch: DatabaseQuery[]): void {
        const transaction = this.database.transaction((queries: DatabaseQuery[]) => {
            queries.forEach((query) => {
                query.executeOn(this.database);
            });
        });
        
        transaction(batch);
    }
}
