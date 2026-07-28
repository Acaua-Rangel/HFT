import { Currency } from "./Currency";

export class Pair {
  constructor(
    private readonly base: Currency,
    private readonly quote: Currency
  ) {}

  public isEquals(other: Pair): boolean {
    const isBaseEquals = this.base.isEquals(other.base);
    const isQuoteEquals = this.quote.isEquals(other.quote);
    return isBaseEquals && isQuoteEquals; // no else, and avoids multiple dots in one line
  }

  public applyBinanceStreamFormat(callback: (streamName: string) => void): void {
    this.base.applySymbol((baseSym) => {
      this.quote.applySymbol((quoteSym) => {
        const streamName = `${baseSym.toLowerCase()}${quoteSym.toLowerCase()}@bookTicker`;
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
