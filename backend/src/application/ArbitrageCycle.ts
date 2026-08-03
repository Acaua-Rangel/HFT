import type { FeeFetcher } from "../domain/interfaces/FeeFetcher";
import type { MathEngine } from "../domain/interfaces/MathEngine";
import type { StateManager } from "../domain/interfaces/StateManager";
import { Amount } from "../domain/valueObjects/Amount";
import { Currency } from "../domain/valueObjects/Currency";
import { Pair } from "../domain/valueObjects/Pair";
import type { CycleEvaluator } from "./CycleEvaluator";
import type { CycleExecutor } from "./CycleExecutor";
import type { TriangularPairs } from "./TriangularPairs";

export class ArbitrageCycle {
	constructor(
		private readonly evaluator: CycleEvaluator,
		private readonly executor: CycleExecutor,
	) {}

	/**
	 * Avalia o lucro teórico de um ciclo SEM executar ordens.
	 * Usado para sondar múltiplos tamanhos de lote rapidamente.
	 */
	public evaluateOnly(
		pairs: TriangularPairs,
		feeFetcher: FeeFetcher,
		_mathEngine: MathEngine,
		initialAmount: Amount,
		bnbDiscount: boolean = false,
		stateManager?: StateManager,
	): Amount {
		let fee1: any, fee2: any, fee3: any;

		pairs.apply((first, second, third) => {
			fee1 = feeFetcher.getFeeFor(first);
			fee2 = feeFetcher.getFeeFor(second);
			fee3 = feeFetcher.getFeeFor(third);

			if (bnbDiscount && stateManager) {
				const bnbUsdtTick = stateManager
					.retrieveOrderBook(
						new Pair(new Currency("BNB"), new Currency("USDT")),
					)
					.getLatest();
				let bnbPrice = 550;
				if (bnbUsdtTick) {
					const cost = bnbUsdtTick.calculateCost(new Amount(1));
					cost.apply((v) => (bnbPrice = v || 550));
				}

				const applyDiscountIfEligible = (pair: Pair, fee: any): any => {
					let eligible = true;
					let assetPriceUsdt = 0;
					const book = stateManager.retrieveOrderBook(pair);
					const tick = book.getLatest();
					if (tick) {
						const cost = tick.calculateCost(new Amount(1));
						let priceInQuote = 0;
						cost.apply((v) => (priceInQuote = v));
						pair.applyCurrencies((_base, quote) => {
							quote.applySymbol((q) => {
								if (q === "USDT") assetPriceUsdt = priceInQuote;
							});
						});
						if (assetPriceUsdt > 0) {
							const priceInBnb = assetPriceUsdt / bnbPrice;
							if (priceInBnb < 0.00000001) eligible = false;
						}
					}
					return eligible ? fee.withBnbDiscount() : fee;
				};

				fee1 = applyDiscountIfEligible(first, fee1);
				fee2 = applyDiscountIfEligible(second, fee2);
				fee3 = applyDiscountIfEligible(third, fee3);
			}
		});

		return this.evaluator.evaluate(pairs, fee1, fee2, fee3, initialAmount);
	}

	public async evaluateAndExecute(
		pairs: TriangularPairs,
		feeFetcher: FeeFetcher,
		mathEngine: MathEngine,
		initialAmount: Amount,
		minProfit: Amount,
		bnbDiscount: boolean = false,
		stateManager?: StateManager,
	): Promise<Amount> {
		let fee1: any, fee2: any, fee3: any;

		pairs.apply((first, second, third) => {
			fee1 = feeFetcher.getFeeFor(first);
			fee2 = feeFetcher.getFeeFor(second);
			fee3 = feeFetcher.getFeeFor(third);

			if (bnbDiscount && stateManager) {
				// Obter o preço do BNB em USDT
				const bnbUsdtTick = stateManager
					.retrieveOrderBook(
						new Pair(new Currency("BNB"), new Currency("USDT")),
					)
					.getLatest();
				let bnbPrice = 550; // default fallback se faltar tick
				if (bnbUsdtTick) {
					// Em vez de complicar com ask/bid, basta um calculateCost genérico p/ 1 token
					const cost = bnbUsdtTick.calculateCost(new Amount(1));
					cost.apply((v) => (bnbPrice = v || 550));
				}

				// Helper genérico para verificar a regra
				const applyDiscountIfEligible = (pair: Pair, fee: any): any => {
					let eligible = true;
					let assetPriceUsdt = 0;
					const book = stateManager.retrieveOrderBook(pair);
					const tick = book.getLatest();

					if (tick) {
						const cost = tick.calculateCost(new Amount(1));
						let priceInQuote = 0;
						cost.apply((v) => (priceInQuote = v));

						pair.applyCurrencies((_base, quote) => {
							quote.applySymbol((q) => {
								// Simplificação: se for cotado em USDT, testamos direto.
								// (Pra BRL daria um pouco diferente, mas SHIB/USDT cobre o gap do HFT)
								if (q === "USDT") {
									assetPriceUsdt = priceInQuote;
								}
							});
						});

						if (assetPriceUsdt > 0) {
							const priceInBnb = assetPriceUsdt / bnbPrice;
							if (priceInBnb < 0.00000001) {
								eligible = false; // BNB Discount NÃO se qualifica!
							}
						}
					}

					return eligible ? fee.withBnbDiscount() : fee;
				};

				fee1 = applyDiscountIfEligible(first, fee1);
				fee2 = applyDiscountIfEligible(second, fee2);
				fee3 = applyDiscountIfEligible(third, fee3);
			}
		});

		const profit = this.evaluator.evaluate(
			pairs,
			fee1,
			fee2,
			fee3,
			initialAmount,
		);

		const isViable = mathEngine.isProfitable(profit, minProfit);
		if (!isViable) {
			return profit; // Return theoretical profit
		}

		const fill = await this.executor.executeCycle(
			pairs,
			initialAmount,
			fee1,
			fee2,
		);

		let actualProfit = profit;
		fill.apply((_qty, quote, _price, success) => {
			if (success) {
				actualProfit = quote.subtract(initialAmount);
			}
		});

		return actualProfit;
	}
}
