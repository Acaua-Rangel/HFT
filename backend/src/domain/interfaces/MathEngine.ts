import { Amount } from "../valueObjects/Amount";
import { Fee } from "../valueObjects/Fee";
import { OrderBook } from "../entities/OrderBook";

export interface MathEngine {
  calculateArbitrageProfit(
    initialBrl: Amount,
    btcBrlBook: OrderBook,
    ethBtcBook: OrderBook,
    ethBrlBook: OrderBook,
    fee1: Fee,
    fee2: Fee,
    fee3: Fee
  ): Amount;

  isProfitable(profit: Amount, minimumExpected: Amount): boolean;
}
