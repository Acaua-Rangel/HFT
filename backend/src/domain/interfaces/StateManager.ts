import { OrderBook } from "../entities/OrderBook";
import { Pair } from "../valueObjects/Pair";
import { Tick } from "../valueObjects/Tick";

export interface StateManager {
  updateState(tick: Tick): void;
  retrieveOrderBook(pair: Pair): OrderBook;
}
