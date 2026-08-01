export class ExecutionRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxBurst: number = 50,
    private readonly windowMs: number = 10000
  ) {}

  public hasCapacityFor(count: number): boolean {
    this.cleanup();
    return (this.timestamps.length + count) <= this.maxBurst;
  }

  public recordUsage(count: number): void {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      this.timestamps.push(now);
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter(t => t > cutoff);
  }
}
