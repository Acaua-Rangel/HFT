import { LocalStateManager } from "../LocalStateManager";

export class RiskManager {
    private highWaterMark: number = 0;
    public MAX_DRAWDOWN_PCT: number = 0.02; // 2% kill switch

    public isKillSwitchEngaged: boolean = false;

    constructor(private readonly maxDrawdownOverride?: number) {
        if (maxDrawdownOverride !== undefined) {
            this.MAX_DRAWDOWN_PCT = maxDrawdownOverride;
        }
    }

    public checkGlobalStopLoss(currentTotalWealth: number): boolean {
        if (this.isKillSwitchEngaged) {
            return true;
        }

        if (currentTotalWealth > this.highWaterMark) {
            this.highWaterMark = currentTotalWealth;
        }

        if (this.highWaterMark > 0) {
            const drawdown = (this.highWaterMark - currentTotalWealth) / this.highWaterMark;
            if (drawdown >= this.MAX_DRAWDOWN_PCT) {
                console.error(`🚨 GLOBAL STOP-LOSS ENGAGED! Drawdown of ${(drawdown * 100).toFixed(2)}% exceeded limit of ${(this.MAX_DRAWDOWN_PCT * 100).toFixed(2)}%`);
                this.isKillSwitchEngaged = true;
                return true;
            }
        }

        return false;
    }
}
