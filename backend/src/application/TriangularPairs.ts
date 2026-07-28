import { Pair } from "../domain/valueObjects/Pair";

export class PairTuple {
  constructor(public readonly first: Pair, public readonly second: Pair) {}
}

export class TriangularPairs {
  constructor(
    public readonly pairTuple: PairTuple,
    public readonly third: Pair
  ) {}

  public apply(callback: (first: Pair, second: Pair, third: Pair) => void): void {
    callback(this.pairTuple.first, this.pairTuple.second, this.third);
  }
}
