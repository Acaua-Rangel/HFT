import { Amount } from "./Amount";
import { Currency } from "./Currency";

export class Money {
  constructor(
    private readonly amount: Amount,
    private readonly currency: Currency
  ) {}

  public isSameCurrencyAs(other: Money): boolean {
    return this.currency.isEquals(other.currency); // wait, one dot per line: other is a Money, we can't access other.currency if it's private.
  }
}
