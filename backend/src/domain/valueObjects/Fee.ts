import { Amount } from "./Amount";

export class Fee {
  public isBnbPaid: boolean = false;

  constructor(public readonly percentage: Amount) {}

  public calculateDiscount(grossAmount: Amount): Amount {
    return grossAmount.multiplyBy(this.percentage);
  }

  public deductFrom(grossAmount: Amount): Amount {
    if (this.isBnbPaid) {
      // Se pago em BNB, o montante base não sofre dedução (100% repassado para a próxima perna)
      return grossAmount;
    }
    const discount = this.calculateDiscount(grossAmount);
    return grossAmount.subtract(discount);
  }

  public withBnbDiscount(): Fee {
    const discountFactor = new Amount(0.75);
    const newFee = new Fee(this.percentage.multiplyBy(discountFactor));
    newFee.isBnbPaid = true;
    return newFee;
  }
}
