import { StateManager } from "../domain/interfaces/StateManager";
import { MathEngine } from "../domain/interfaces/MathEngine";
import { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { FeeFetcher } from "../domain/interfaces/FeeFetcher";

export class ArbitrageServices {
  constructor(
    public readonly state: StateManager,
    public readonly math: MathEngine,
    public readonly executor: OrderExecutor,
    public readonly fees: FeeFetcher
  ) {}
}
