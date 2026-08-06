import { Amount } from "../valueObjects/Amount";
import { Pair } from "../valueObjects/Pair";
import { OrderFill } from "../valueObjects/OrderFill";

export interface OrderExecutor {
  executeMakerBuy(pair: Pair, amount: Amount, price?: Amount): Promise<OrderFill>;
  executeMakerSell(pair: Pair, amount: Amount, price?: Amount): Promise<OrderFill>;
  canExecuteBatch(count: number): boolean;
}

