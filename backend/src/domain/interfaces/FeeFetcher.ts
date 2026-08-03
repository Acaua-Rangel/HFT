import type { Fee } from "../valueObjects/Fee";
import type { Pair } from "../valueObjects/Pair";

export interface FeeFetcher {
	preloadFees(pairs: Pair[]): Promise<void>;
	getFeeFor(pair: Pair): Fee;
}
