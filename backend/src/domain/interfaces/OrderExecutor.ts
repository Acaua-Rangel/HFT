import type { Amount } from "../valueObjects/Amount";
import type { OrderFill } from "../valueObjects/OrderFill";
import type { Pair } from "../valueObjects/Pair";

export interface OrderExecutor {
	executeMarketBuy(pair: Pair, amount: Amount): Promise<OrderFill>;
	executeMarketSell(pair: Pair, amount: Amount): Promise<OrderFill>;
	canExecuteBatch(count: number): boolean;
}
