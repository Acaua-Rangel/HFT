import { Database } from "bun:sqlite";
import { AsyncDatabaseWriter, QueryQueue, ProcessingState } from "./AsyncDatabaseWriter";

export class DatabaseFilePath {
    constructor(private readonly value: string) {}
    public asString(): string { return this.value; }
}

export class DatabaseFactory {
    public static create(path: DatabaseFilePath): Database {
        return new Database(path.asString());
    }
}

export class AsyncWriterFactory {
    public static create(database: Database): AsyncDatabaseWriter {
        const queue = new QueryQueue();
        const state = new ProcessingState();
        return new AsyncDatabaseWriter(database, queue, state);
    }
}
