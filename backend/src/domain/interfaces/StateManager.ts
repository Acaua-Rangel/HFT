import type { OrderBook } from "../entities/OrderBook";
import type { Pair } from "../valueObjects/Pair";
import type { Tick } from "../valueObjects/Tick";

export interface StateManager {
	updateState(tick: Tick): void;
	retrieveOrderBook(pair: Pair): OrderBook;
}
