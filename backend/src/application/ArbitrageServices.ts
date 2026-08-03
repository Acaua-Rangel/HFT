import type { FeeFetcher } from "../domain/interfaces/FeeFetcher";
import type { MathEngine } from "../domain/interfaces/MathEngine";
import type { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import type { StateManager } from "../domain/interfaces/StateManager";

export class ArbitrageServices {
	constructor(
		public readonly state: StateManager,
		public readonly math: MathEngine,
		public readonly executor: OrderExecutor,
		public readonly fees: FeeFetcher,
	) {}
}
