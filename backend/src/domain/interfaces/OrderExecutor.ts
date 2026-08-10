import { Amount } from "../valueObjects/Amount";
import { Pair } from "../valueObjects/Pair";
import { OrderFill } from "../valueObjects/OrderFill";

export interface ActiveOrder {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  timestamp: number;
}

export interface OrderExecutor {
  executeMakerBuy(pair: Pair, amount: Amount, price?: Amount): Promise<ActiveOrder | null>;
  executeMakerSell(pair: Pair, amount: Amount, price?: Amount): Promise<ActiveOrder | null>;
  cancelOrder(order: ActiveOrder): Promise<OrderFill>;
  cancelAllOrders(pair: Pair): Promise<void>;
  canExecuteBatch(count: number): boolean;
}

