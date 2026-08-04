export class Currency {
  constructor(private readonly symbol: string) {}

  public isEquals(other: Currency): boolean {
    return this.symbol === other.symbol;
  }

  public applySymbol(callback: (symbol: string) => void): void {
    callback(this.symbol);
  }
}
