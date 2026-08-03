import type { MathEngine } from "../domain/interfaces/MathEngine";
import type { PrecisionFetcher } from "../domain/interfaces/PrecisionFetcher";
import type { StateManager } from "../domain/interfaces/StateManager";
import { Amount } from "../domain/valueObjects/Amount";
import type { Fee } from "../domain/valueObjects/Fee";
import type { Pair } from "../domain/valueObjects/Pair";
import type { TriangularPairs } from "./TriangularPairs";

export class CycleEvaluator {
	constructor(
		private readonly stateManager: StateManager,
		private readonly mathEngine: MathEngine,
		private readonly precisionFetcher?: PrecisionFetcher,
	) {}

	public evaluate(
		pairs: TriangularPairs,
		fee1: Fee,
		fee2: Fee,
		fee3: Fee,
		initialAmount: Amount,
	): Amount {
		let profitResult = new Amount(0);

		pairs.apply((first: Pair, second: Pair, third: Pair) => {
			const firstBook = this.stateManager.retrieveOrderBook(first);
			const secondBook = this.stateManager.retrieveOrderBook(second);
			const thirdBook = this.stateManager.retrieveOrderBook(third);

			profitResult = this.mathEngine.calculateArbitrageProfit(
				initialAmount,
				firstBook,
				secondBook,
				thirdBook,
				fee1,
				fee2,
				fee3,
				this.precisionFetcher,
			);
		});

		return profitResult;
	}
}
