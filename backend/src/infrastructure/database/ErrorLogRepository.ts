import {
	type AsyncDatabaseWriter,
	DatabaseQuery,
	QueryParameters,
	SqlStatement,
} from "./AsyncDatabaseWriter";
import type { LogId, Timestamp } from "./TransactionRepository";

export class ErrorType {
	constructor(private readonly value: string) {}
	public asString(): string {
		return this.value;
	}
}

export class ErrorMessage {
	constructor(private readonly value: string) {}
	public asString(): string {
		return this.value;
	}
}

export class StackTrace {
	constructor(private readonly value: string | null) {}
	public asStringOrNull(): string | null {
		return this.value;
	}
}

export class ErrorContext {
	constructor(private readonly value: string | null) {}
	public asStringOrNull(): string | null {
		return this.value;
	}
}

export class ErrorLogEntry {
	constructor(
		private readonly id: LogId,
		private readonly timestamp: Timestamp,
		private readonly errorType: ErrorType,
		private readonly message: ErrorMessage,
		private readonly stackTrace: StackTrace,
		private readonly context: ErrorContext,
	) {}

	public toQuery(): DatabaseQuery {
		const statement = new SqlStatement(
			`INSERT INTO error_logs (id, timestamp, error_type, message, stack_trace, context) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const parameters = new QueryParameters([
			this.id.asString(),
			this.timestamp.asNumber(),
			this.errorType.asString(),
			this.message.asString(),
			this.stackTrace.asStringOrNull(),
			this.context.asStringOrNull(),
		]);
		return new DatabaseQuery(statement, parameters);
	}
}

export class ErrorLogRepository {
	constructor(private readonly writer: AsyncDatabaseWriter) {}

	public save(entry: ErrorLogEntry): void {
		this.writer.enqueue(entry.toQuery());
	}
}
