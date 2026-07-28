import { Fee } from "../valueObjects/Fee";
import { Pair } from "../valueObjects/Pair";

export interface FeeFetcher {
  fetchFeeFor(pair: Pair): Promise<Fee>;
}
