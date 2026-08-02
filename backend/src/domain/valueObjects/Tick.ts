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
    if (this.asks.length > 0) {
      return this.asks[0].price.multiplyBy(quantity);
    }
    return new Amount(0);
  }

  // Comprando Base Asset gastando Quote Asset (VWAP)
  public convertBuy(quoteAmount: Amount): Amount {
    let quoteRemaining = 0;
    quoteAmount.apply(v => quoteRemaining = v);
    
    let baseReceived = 0;

    for (const level of this.asks) {
      let levelPrice = 0;
      let levelQty = 0;
      level.price.apply(v => levelPrice = v);
      level.qty.apply(v => levelQty = v);

      const maxQuoteCanBuyHere = levelPrice * levelQty;

      if (quoteRemaining <= maxQuoteCanBuyHere) {
        // Enchemos nossa ordem neste nível
        baseReceived += quoteRemaining / levelPrice;
        quoteRemaining = 0;
        break;
      } else {
        // Compramos tudo que tem neste nível e vamos para o próximo
        baseReceived += levelQty;
        quoteRemaining -= maxQuoteCanBuyHere;
      }
    }

    // Se varremos todo o livro e ainda sobrou cota, significa que a corretora não tem liquidez.
    // Retornamos 0 ou negativo para o MathEngine rejeitar sumariamente.
    if (quoteRemaining > 0) {
       return new Amount(-9999999);
    }

    return new Amount(baseReceived);
  }

  // Vendendo Base Asset para receber Quote Asset (VWAP)
  public convertSell(baseAmount: Amount): Amount {
    let baseRemaining = 0;
    baseAmount.apply(v => baseRemaining = v);

    let quoteReceived = 0;

    for (const level of this.bids) {
      let levelPrice = 0;
      let levelQty = 0;
      level.price.apply(v => levelPrice = v);
      level.qty.apply(v => levelQty = v);

      if (baseRemaining <= levelQty) {
        // Enchemos a nossa ordem neste nível
        quoteReceived += baseRemaining * levelPrice;
        baseRemaining = 0;
        break;
      } else {
        // Vendemos tudo que tem neste nível e vamos para o próximo
        quoteReceived += levelQty * levelPrice;
        baseRemaining -= levelQty;
      }
    }

    // Se faltar liquidez, inviabilizamos o trade.
    if (baseRemaining > 0) {
      return new Amount(-9999999);
    }

    return new Amount(quoteReceived);
  }

  public applyBinanceSymbol(callback: (symbol: string) => void): void {
    this.pair.applyBinanceSymbol(callback);
  }
}
