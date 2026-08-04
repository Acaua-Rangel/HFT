import { Fee } from "../valueObjects/Fee";
import { Pair } from "../valueObjects/Pair";

export interface FeeFetcher {
  preloadFees(pairs: Pair[]): Promise<void>;
  getFeeFor(pair: Pair): Fee;
}
