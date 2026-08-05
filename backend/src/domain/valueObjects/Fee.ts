import { Amount } from "./Amount";

export class Fee {

  constructor(public readonly percentage: Amount) {}

  public calculateDiscount(grossAmount: Amount): Amount {
    return grossAmount.multiplyBy(this.percentage);
  }

  public deductFrom(grossAmount: Amount): Amount {

    const discount = this.calculateDiscount(grossAmount);
    return grossAmount.subtract(discount);
  }

}
