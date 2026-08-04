import { Currency } from "./Currency";

export class Pair {
  constructor(
    private readonly base: Currency,
    private readonly quote: Currency
  ) {}

  public isEquals(other: Pair): boolean {
    const isBaseEquals = this.base.isEquals(other.base);
    const isQuoteEquals = this.quote.isEquals(other.quote);
    return isBaseEquals && isQuoteEquals; 
  }

  public toString(): string {
    let result = "";
    this.base.applySymbol(b => {
        this.quote.applySymbol(q => {
            result = `${b}/${q}`;
        });
    });
    return result;
  }

  public applyBinanceStreamFormat(callback: (streamName: string) => void): void {
    this.base.applySymbol((baseSym) => {
      this.quote.applySymbol((quoteSym) => {
        const streamName = `${baseSym.toLowerCase()}${quoteSym.toLowerCase()}@depth20@100ms`;
        callback(streamName);
      });
    });
  }

  public applyBinanceSymbol(callback: (symbol: string) => void): void {
    this.base.applySymbol((baseSym) => {
      this.quote.applySymbol((quoteSym) => {
        const symbol = `${baseSym.toUpperCase()}${quoteSym.toUpperCase()}`;
        callback(symbol);
      });
    });
  }

  public applyCurrencies(callback: (base: Currency, quote: Currency) => void): void {
    callback(this.base, this.quote);
  }
}
