import { Pair } from "./Pair";
import { Amount } from "./Amount";

export class Tick {
  constructor(
    private readonly pair: Pair,
    private readonly askPrice: Amount,
    private readonly bidPrice: Amount
  ) {}

  public isForPair(targetPair: Pair): boolean {
    return this.pair.isEquals(targetPair);
  }

  // Comprando: Usamos o Ask Price (o mais caro da corretora)
  public calculateCost(quantity: Amount): Amount {
    return this.askPrice.multiplyBy(quantity);
  }

  public convertBuy(quoteAmount: Amount): Amount {
    return quoteAmount.divideBy(this.askPrice);
  }

  // Vendendo: Usamos o Bid Price (o mais barato que a corretora paga)
  public convertSell(baseAmount: Amount): Amount {
    return baseAmount.multiplyBy(this.bidPrice);
  }

  public applyBinanceSymbol(callback: (symbol: string) => void): void {
    this.pair.applyBinanceSymbol(callback);
  }
}
