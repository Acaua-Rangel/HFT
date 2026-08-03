import { Database } from "bun:sqlite";
import {
	AsyncDatabaseWriter,
	ProcessingState,
	QueryQueue,
} from "./AsyncDatabaseWriter";

export class DatabaseFilePath {
	constructor(private readonly value: string) {}
	public asString(): string {
		return this.value;
	}
}

export class DatabaseFactory {
	public static create(path: DatabaseFilePath): Database {
		const db = new Database(path.asString());

		db.run(`CREATE TABLE IF NOT EXISTS transaction_logs (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            trade_id TEXT NOT NULL,
            asset TEXT NOT NULL,
            amount REAL NOT NULL,
            price REAL NOT NULL,
            profit REAL NOT NULL,
            status TEXT NOT NULL
        )`);

		db.run(`CREATE TABLE IF NOT EXISTS market_ticks (
            timestamp INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            bid_price REAL NOT NULL,
            bid_qty REAL NOT NULL,
            ask_price REAL NOT NULL,
            ask_qty REAL NOT NULL
        )`);

		db.run(`CREATE TABLE IF NOT EXISTS error_logs (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            error_type TEXT NOT NULL,
            message TEXT NOT NULL,
            stack_trace TEXT,
            context TEXT
        )`);

		return db;
	}
}

export class AsyncWriterFactory {
	public static create(database: Database): AsyncDatabaseWriter {
		const queue = new QueryQueue();
		const state = new ProcessingState();
		return new AsyncDatabaseWriter(database, queue, state);
	}
}
