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

    return finalBrl.subtract(initialBrl);
  }

  public isProfitable(profit: Amount, minimumExpected: Amount): boolean {
    return profit.isGreaterThan(minimumExpected);
  }
}
