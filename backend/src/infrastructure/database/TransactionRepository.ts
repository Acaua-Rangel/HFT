import { AsyncDatabaseWriter, DatabaseQuery, SqlStatement, QueryParameters } from "./AsyncDatabaseWriter";

export class LogId {
    constructor(private readonly value: string) {}
    public asString(): string { return this.value; }
}

export class Timestamp {
    constructor(private readonly value: number) {}
    public asNumber(): number { return this.value; }
}

export class TradeId {
    constructor(private readonly value: string) {}
    public asString(): string { return this.value; }
}

export class AssetName {
    constructor(private readonly value: string) {}
    public asString(): string { return this.value; }
}

export class MonetaryValue {
    constructor(private readonly value: number) {}
    public asNumber(): number { return this.value; }
}

export class TradeStatus {
    constructor(private readonly value: string) {}
    public asString(): string { return this.value; }
}

export class TransactionLogEntry {
    constructor(
        private readonly id: LogId,
        private readonly timestamp: Timestamp,
        private readonly tradeId: TradeId,
        private readonly asset: AssetName,
        private readonly amount: MonetaryValue,
        private readonly price: MonetaryValue,
        private readonly profit: MonetaryValue,
        private readonly status: TradeStatus
    ) {}

    public toQuery(): DatabaseQuery {
        const statement = new SqlStatement(
            `INSERT INTO transaction_logs (id, timestamp, trade_id, asset, amount, price, profit, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const parameters = new QueryParameters([
            this.id.asString(),
            this.timestamp.asNumber(),
            this.tradeId.asString(),
            this.asset.asString(),
            this.amount.asNumber(),
            this.price.asNumber(),
            this.profit.asNumber(),
            this.status.asString()
        ]);
        return new DatabaseQuery(statement, parameters);
    }
}

export class TransactionRepository {
    constructor(private readonly writer: AsyncDatabaseWriter) {}

    public save(entry: TransactionLogEntry): void {
        this.writer.enqueue(entry.toQuery());
    }
}
