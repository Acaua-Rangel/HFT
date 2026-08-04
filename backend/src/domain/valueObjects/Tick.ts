import { Pair } from "./Pair";
import { Amount } from "./Amount";

export interface Level {
  price: Amount;
  qty: Amount;
}

export class Tick {
  constructor(
    private readonly pair: Pair,
    private readonly asks: Level[],
    private readonly bids: Level[]
  ) {}

  public isForPair(targetPair: Pair): boolean {
    return this.pair.isEquals(targetPair);
  }

  public calculateCost(quantity: Amount): Amount {
    // Apenas para testes antigos que precisam de um preço (usamos o melhor ask)
    if (this.asks.length > 0 && this.asks[0]) {
      return this.asks[0].price.multiplyBy(quantity);
    }
    return new Amount(0);
  }

  public getMidPrice(): Amount | undefined {
    if (this.asks.length > 0 && this.bids.length > 0 && this.asks[0] && this.bids[0]) {
      let askPrice = 0, bidPrice = 0;
      this.asks[0].price.apply(v => askPrice = v);
      this.bids[0].price.apply(v => bidPrice = v);
      return new Amount((askPrice + bidPrice) / 2);
    }
    return undefined;
  }

  // Comprando Base Asset gastando Quote Asset (Cruzando o Spread -> paga o Ask)
  public convertBuy(quoteAmount: Amount): Amount {
    if (this.asks.length === 0 || !this.asks[0]) return new Amount(-9999999);
    
    let askPrice = 0, quoteRemaining = 0;
    this.asks[0].price.apply(v => askPrice = v);
    quoteAmount.apply(v => quoteRemaining = v);
    
    if (askPrice === 0) return new Amount(-9999999);
    return new Amount(quoteRemaining / askPrice);
  }

  // Vendendo Base Asset para receber Quote Asset (Cruzando o Spread -> recebe o Bid)
  public convertSell(baseAmount: Amount): Amount {
    if (this.bids.length === 0 || !this.bids[0]) return new Amount(-9999999);

    let bidPrice = 0, baseRemaining = 0;
    this.bids[0].price.apply(v => bidPrice = v);
    baseAmount.apply(v => baseRemaining = v);
    
    return new Amount(baseRemaining * bidPrice);
  }

  public applyBinanceSymbol(callback: (symbol: string) => void): void {
    this.pair.applyBinanceSymbol(callback);
  }

  public applyTopAsk(callback: (level: Level | undefined) => void): void {
    callback(this.asks.length > 0 ? this.asks[0] : undefined);
  }

  public applyTopBid(callback: (level: Level | undefined) => void): void {
    callback(this.bids.length > 0 ? this.bids[0] : undefined);
  }

  public applyTopNAsks(n: number, callback: (levels: Level[]) => void): void {
    callback(this.asks.slice(0, n));
  }

  public applyTopNBids(n: number, callback: (levels: Level[]) => void): void {
    callback(this.bids.slice(0, n));
  }
}
