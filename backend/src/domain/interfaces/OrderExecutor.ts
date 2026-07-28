import { Amount } from "../valueObjects/Amount";
import { Pair } from "../valueObjects/Pair";

export interface OrderExecutor {
  executeMarketBuy(pair: Pair, amount: Amount): void;
  executeMarketSell(pair: Pair, amount: Amount): void;
  executeMarketSellWithTimeout(pair: Pair, amount: Amount, timeoutMs: number): void;
}
