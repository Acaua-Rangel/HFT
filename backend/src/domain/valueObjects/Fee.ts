import { Amount } from "./Amount";

export class Fee {
  constructor(private readonly percentage: Amount) {}

  public calculateDiscount(grossAmount: Amount): Amount {
    return grossAmount.multiplyBy(this.percentage);
  }

  public deductFrom(grossAmount: Amount): Amount {
    const discount = this.calculateDiscount(grossAmount);
    return grossAmount.subtract(discount);
  }

  public withBnbDiscount(): Fee {
    const discountFactor = new Amount(0.75);
    return new Fee(this.percentage.multiplyBy(discountFactor));
  }
}
