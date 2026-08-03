import type { Pair } from "../domain/valueObjects/Pair";

export class PairTuple {
	constructor(
		public readonly first: Pair,
		public readonly second: Pair,
	) {}
}

export class TriangularPairs {
	constructor(
		public readonly pairTuple: PairTuple,
		public readonly third: Pair,
	) {}

	public apply(
		callback: (first: Pair, second: Pair, third: Pair) => void,
	): void {
		callback(this.pairTuple.first, this.pairTuple.second, this.third);
	}

	public async applyAsync(
		callback: (first: Pair, second: Pair, third: Pair) => Promise<void>,
	): Promise<void> {
		await callback(this.pairTuple.first, this.pairTuple.second, this.third);
	}
}
