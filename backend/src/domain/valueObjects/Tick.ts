import { Pair } from "./Pair";
import { Amount } from "./Amount";

export class Tick {
  constructor(
    private readonly pair: Pair,
    private readonly price: Amount
  ) {}

  public isForPair(targetPair: Pair): boolean {
    return this.pair.isEquals(targetPair);
  }

  public calculateCost(quantity: Amount): Amount {
    return this.price.multiplyBy(quantity);
  }

  public convertBuy(quoteAmount: Amount): Amount {
    return quoteAmount.divideBy(this.price);
  }

  public convertSell(baseAmount: Amount): Amount {
    return baseAmount.multiplyBy(this.price);
  }

  public applyBinanceSymbol(callback: (symbol: string) => void): void {
    this.pair.applyBinanceSymbol(callback);
  }
}
