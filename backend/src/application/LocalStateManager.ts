import { OrderBook } from "../domain/entities/OrderBook";
import type { StateManager } from "../domain/interfaces/StateManager";
import type { Pair } from "../domain/valueObjects/Pair";
import type { Tick } from "../domain/valueObjects/Tick";

export class LocalStateManager implements StateManager {
	private readonly books: Map<string, OrderBook> = new Map();

	public registerPair(pair: Pair): void {
		let symbol = "";
		pair.applyBinanceSymbol((sym) => (symbol = sym));
		this.books.set(symbol, new OrderBook());
	}

	public updateState(tick: Tick): void {
		let symbol = "";
		tick.applyBinanceSymbol((sym) => (symbol = sym));

		const book = this.books.get(symbol);
		if (book) {
			book.add(tick);
		}
	}

	public retrieveOrderBook(pair: Pair): OrderBook {
		let symbol = "";
		pair.applyBinanceSymbol((sym) => (symbol = sym));
		return this.books.get(symbol) || new OrderBook();
	}
}
