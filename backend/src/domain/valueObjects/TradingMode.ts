export class TradingMode {
  public static readonly SIMULATION = new TradingMode("SIMULATION");
  public static readonly LIVE = new TradingMode("LIVE");

  private constructor(private readonly mode: string) {}

  public isSimulation(): boolean {
    return this.mode === TradingMode.SIMULATION.mode;
  }

  public isLive(): boolean {
    return this.mode === TradingMode.LIVE.mode;
  }

  public apply(callback: (mode: string) => void): void {
    callback(this.mode);
  }
}
