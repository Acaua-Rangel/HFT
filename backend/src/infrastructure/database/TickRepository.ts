import type { Tick } from "../../domain/valueObjects/Tick";
import {
	type AsyncDatabaseWriter,
	DatabaseQuery,
	QueryParameters,
	SqlStatement,
} from "./AsyncDatabaseWriter";

export class TickLogEntry {
	constructor(
		private readonly timestamp: number,
		private readonly symbol: string,
		private readonly bidPrice: number,
		private readonly bidQty: number,
		private readonly askPrice: number,
		private readonly askQty: number,
	) {}

	public static fromTick(tick: Tick): TickLogEntry {
		let symbol = "";
		tick.pair.applyBinanceSymbol((s) => (symbol = s));

		const bestBid = tick.bids.length > 0 ? tick.bids[0] : null;
		const bestAsk = tick.asks.length > 0 ? tick.asks[0] : null;

		let bidPrice = 0,
			bidQty = 0,
			askPrice = 0,
			askQty = 0;

		if (bestBid) {
			bestBid.price.apply((v) => (bidPrice = v));
			bestBid.qty.apply((v) => (bidQty = v));
		}
		if (bestAsk) {
			bestAsk.price.apply((v) => (askPrice = v));
			bestAsk.qty.apply((v) => (askQty = v));
		}

		return new TickLogEntry(
			Date.now(), // timestamp of ingestion
			symbol,
			bidPrice,
			bidQty,
			askPrice,
			askQty,
		);
	}

	public toQuery(): DatabaseQuery {
		const statement = new SqlStatement(
			`INSERT INTO market_ticks (timestamp, symbol, bid_price, bid_qty, ask_price, ask_qty) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const parameters = new QueryParameters([
			this.timestamp,
			this.symbol,
			this.bidPrice,
			this.bidQty,
			this.askPrice,
			this.askQty,
		]);
		return new DatabaseQuery(statement, parameters);
	}
}

export class TickRepository {
	constructor(private readonly writer: AsyncDatabaseWriter) {}

	public saveTick(tick: Tick): void {
		const entry = TickLogEntry.fromTick(tick);
		this.writer.enqueue(entry.toQuery());
	}
}
