import type { OrderBook } from "../domain/entities/OrderBook";
import type { MathEngine } from "../domain/interfaces/MathEngine";
import type { PrecisionFetcher } from "../domain/interfaces/PrecisionFetcher";
import { Amount } from "../domain/valueObjects/Amount";
import type { Fee } from "../domain/valueObjects/Fee";
import type { Tick } from "../domain/valueObjects/Tick";

export class ArbitrageMathEngine implements MathEngine {
	public calculateFirstLeg(
		tick: Tick,
		fee: Fee,
		amountInUsdt: Amount,
		isBnbDiscountEnabled: boolean,
	): Amount {
		let val = 0;
		amountInUsdt.apply((v) => (val = v));
		const bought = tick.convertBuy(new Amount(val));
		return fee.deductFrom(bought);
	}

	public calculateSecondLeg(
		tick: Tick,
		fee: Fee,
		amountInUsdt: Amount,
		isBnbDiscountEnabled: boolean,
	): Amount {
		let val = 0;
		amountInUsdt.apply((v) => (val = v));
		const bought = tick.convertBuy(new Amount(val));
		return fee.deductFrom(bought);
	}

	public calculateThirdLeg(
		tick: Tick,
		fee: Fee,
		amountInUsdt: Amount,
		isBnbDiscountEnabled: boolean,
	): Amount {
		let val = 0;
		amountInUsdt.apply((v) => (val = v));
		const sold = tick.convertSell(new Amount(val));
		return fee.deductFrom(sold);
	}

	public calculateArbitrageProfit(
		initialBrl: Amount,
		btcBrlBook: OrderBook,
		ethBtcBook: OrderBook,
		ethBrlBook: OrderBook,
		fee1: Fee,
		fee2: Fee,
		fee3: Fee,
		precisionFetcher?: PrecisionFetcher,
	): Amount {
		const btcBrlTick = btcBrlBook.getLatest();
		const ethBtcTick = ethBtcBook.getLatest();
		const ethBrlTick = ethBrlBook.getLatest();

		const isMissingData =
			btcBrlTick === undefined ||
			ethBtcTick === undefined ||
			ethBrlTick === undefined;
		if (isMissingData) {
			return new Amount(-9999999);
		}

		// Leg 1: BUY
		let initialBrlVal = 0;
		initialBrl.apply((v) => (initialBrlVal = v));

		let leg1Truncated = initialBrlVal;
		if (precisionFetcher) {
			let btcBrlSym = "";
			btcBrlTick?.applyBinanceSymbol((sym) => (btcBrlSym = sym.toUpperCase()));
			let decimals = 8;
			if (
				btcBrlSym.endsWith("BRL") ||
				btcBrlSym.endsWith("EUR") ||
				btcBrlSym.endsWith("TRY")
			)
				decimals = 2;
			else if (
				btcBrlSym.endsWith("USDT") ||
				btcBrlSym.endsWith("USDC") ||
				btcBrlSym.endsWith("FDUSD")
			)
				decimals = 4;
			const factor = 10 ** decimals;
			leg1Truncated = Math.floor(initialBrlVal * factor) / factor;
		}

		const btcBought = btcBrlTick?.convertBuy(new Amount(leg1Truncated));
		const btcAfterFee = fee1.deductFrom(btcBought);

		// Leg 2: BUY
		let btcAfterFeeVal = 0;
		btcAfterFee.apply((v) => (btcAfterFeeVal = v));

		let leg2Truncated = btcAfterFeeVal;
		if (precisionFetcher) {
			let ethBtcSym = "";
			ethBtcTick?.applyBinanceSymbol((sym) => (ethBtcSym = sym.toUpperCase()));
			let decimals = 8;
			if (
				ethBtcSym.endsWith("BRL") ||
				ethBtcSym.endsWith("EUR") ||
				ethBtcSym.endsWith("TRY")
			)
				decimals = 2;
			else if (
				ethBtcSym.endsWith("USDT") ||
				ethBtcSym.endsWith("USDC") ||
				ethBtcSym.endsWith("FDUSD")
			)
				decimals = 4;
			const factor = 10 ** decimals;
			leg2Truncated = Math.floor(btcAfterFeeVal * factor) / factor;
		}

		const ethBought = ethBtcTick?.convertBuy(new Amount(leg2Truncated));
		const ethAfterFee = fee2.deductFrom(ethBought);

		// Leg 3: SELL
		let ethAfterFeeVal = 0;
		ethAfterFee.apply((v) => (ethAfterFeeVal = v));

		let leg3Truncated = ethAfterFeeVal;
		if (precisionFetcher) {
			let ethBrlSym = "";
			ethBrlTick?.applyBinanceSymbol((sym) => (ethBrlSym = sym.toUpperCase()));
			const decimals = precisionFetcher.getQuantityDecimals(ethBrlSym);
			const factor = 10 ** decimals;
			leg3Truncated = Math.floor(ethAfterFeeVal * factor) / factor;
		}

		const brlReceived = ethBrlTick?.convertSell(new Amount(leg3Truncated));
		const finalBrl = fee3.deductFrom(brlReceived);

		let profitResult = finalBrl.subtract(initialBrl);

		// Se as taxas forem pagas em BNB, os volumes repassados nas pernas foram de 100% (sem desconto)
		// Para refletir o verdadeiro lucro, precisamos descontar o valor equivalente em BRL do BNB que foi gasto.
		if (fee1.isBnbPaid) {
			let f1 = 0,
				f2 = 0,
				f3 = 0,
				initBrl = 0;
			fee1.percentage.apply((v) => (f1 = v));
			fee2.percentage.apply((v) => (f2 = v));
			fee3.percentage.apply((v) => (f3 = v));
			initialBrl.apply((v) => (initBrl = v));

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
