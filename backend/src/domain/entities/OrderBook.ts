import { Tick } from "../valueObjects/Tick";

export class OrderBook {
  private latestTick?: Tick;

  public add(tick: Tick): void {
    this.latestTick = tick;
  }

  public getLatest(): Tick | undefined {
    return this.latestTick;
  }
}
