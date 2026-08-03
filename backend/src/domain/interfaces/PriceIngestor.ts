import type { Pair } from "../valueObjects/Pair";
import type { Tick } from "../valueObjects/Tick";

export interface PriceIngestor {
	subscribe(pair: Pair): void;
	onTick(callback: (tick: Tick) => void): void;
}
