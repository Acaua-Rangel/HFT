import { Tick } from "../valueObjects/Tick";

export class OrderBook {
  constructor(private readonly ticks: Tick[] = []) {}

  public add(tick: Tick): OrderBook {
    return new OrderBook([...this.ticks, tick]);
  }

  public getLatest(): Tick | undefined {
    const hasNoTicks = this.ticks.length === 0;
    if (hasNoTicks) {
      return undefined;
    }
    const lastIndex = this.ticks.length - 1;
    return this.ticks[lastIndex];
  }
}
