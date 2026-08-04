import { Amount } from "../valueObjects/Amount";
import { Pair } from "../valueObjects/Pair";
import { OrderFill } from "../valueObjects/OrderFill";

export interface OrderExecutor {
  executeMarketBuy(pair: Pair, amount: Amount): Promise<OrderFill>;
  executeMarketSell(pair: Pair, amount: Amount): Promise<OrderFill>;
  canExecuteBatch(count: number): boolean;
}
