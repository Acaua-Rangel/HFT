import type { OrderBook } from "../entities/OrderBook";
import type { Amount } from "../valueObjects/Amount";
import type { Fee } from "../valueObjects/Fee";
import type { PrecisionFetcher } from "./PrecisionFetcher";

export interface MathEngine {
	calculateArbitrageProfit(
		initialBrl: Amount,
		btcBrlBook: OrderBook,
		ethBtcBook: OrderBook,
		ethBrlBook: OrderBook,
		fee1: Fee,
		fee2: Fee,
		fee3: Fee,
		precisionFetcher?: PrecisionFetcher,
	): Amount;

	isProfitable(profit: Amount, minimumExpected: Amount): boolean;
}
