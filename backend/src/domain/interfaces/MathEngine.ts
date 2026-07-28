import { Amount } from "../valueObjects/Amount";
import { Fee } from "../valueObjects/Fee";
import { OrderBook } from "../entities/OrderBook";

export interface MathEngine {
  calculateArbitrageProfit(
    initialAmount: Amount,
    firstOrderBook: OrderBook,
    secondOrderBook: OrderBook,
    thirdOrderBook: OrderBook,
    fee: Fee
  ): Amount;

  isProfitable(profit: Amount, minimumExpected: Amount): boolean;
}
