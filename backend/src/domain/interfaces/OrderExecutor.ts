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

  /**
   * Ordens a mercado (taker). Existem para o mecanismo de defesa de estoque, não para
   * cotar: um market maker que agride o book paga o spread em vez de capturá-lo.
   *
   * O retorno é `OrderFill` e não `ActiveOrder` porque uma ordem a mercado não descansa
   * no book — ela é um preenchimento, não uma ordem rastreável. Nunca devem entrar nos
   * arrays de ordens ativas do MarketMakerCycle.
   *
   * ATENÇÃO: são taker. A promo de taxa zero do BTCFDUSD pode valer só para maker; medir
   * a comissão realizada (scripts/binance-audit.ts) antes de acionar isto com frequência.
   */
  executeMarketSell(pair: Pair, baseAmount: Amount): Promise<OrderFill>;
  executeMarketBuy(pair: Pair, quoteAmount: Amount): Promise<OrderFill>;

  cancelOrder(order: ActiveOrder): Promise<OrderFill>;
  cancelAllOrders(pair: Pair): Promise<void>;
  canExecuteBatch(count: number): boolean;
  logError(type: string, message: string): void;
}

