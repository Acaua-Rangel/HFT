import { MathEngine } from "../domain/interfaces/MathEngine";
import { Amount } from "../domain/valueObjects/Amount";
import { Fee } from "../domain/valueObjects/Fee";
import { OrderBook } from "../domain/entities/OrderBook";

export class ArbitrageMathEngine implements MathEngine {
  public calculateArbitrageProfit(
    initialBrl: Amount,
    btcBrlBook: OrderBook,
    ethBtcBook: OrderBook,
    ethBrlBook: OrderBook,
    fee1: Fee,
    fee2: Fee,
    fee3: Fee
  ): Amount {
    const btcBrlTick = btcBrlBook.getLatest();
    const ethBtcTick = ethBtcBook.getLatest();
    const ethBrlTick = ethBrlBook.getLatest();

    const isMissingData = btcBrlTick === undefined || ethBtcTick === undefined || ethBrlTick === undefined;
    if (isMissingData) {
      return new Amount(-9999999);
    }

    const btcBought = btcBrlTick.convertBuy(initialBrl);
    const btcAfterFee = fee1.deductFrom(btcBought);

    const ethBought = ethBtcTick.convertBuy(btcAfterFee);
    const ethAfterFee = fee2.deductFrom(ethBought);

    const brlReceived = ethBrlTick.convertSell(ethAfterFee);
    const finalBrl = fee3.deductFrom(brlReceived);

    let profitResult = finalBrl.subtract(initialBrl);

    // Se as taxas forem pagas em BNB, os volumes repassados nas pernas foram de 100% (sem desconto)
    // Para refletir o verdadeiro lucro, precisamos descontar o valor equivalente em BRL do BNB que foi gasto.
    if (fee1.isBnbPaid) {
      let f1 = 0, f2 = 0, f3 = 0, initBrl = 0;
      fee1.percentage.apply(v => f1 = v);
      fee2.percentage.apply(v => f2 = v);
      fee3.percentage.apply(v => f3 = v);
      initialBrl.apply(v => initBrl = v);

      const totalFeePercentage = f1 + f2 + f3;
      const estimatedBnbCostInBrl = initBrl * totalFeePercentage;
      
      profitResult = profitResult.subtract(new Amount(estimatedBnbCostInBrl));
    }

    return profitResult;
  }

  public isProfitable(profit: Amount, minimumExpected: Amount): boolean {
    return profit.isGreaterThan(minimumExpected);
  }
}
