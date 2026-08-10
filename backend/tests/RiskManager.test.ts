import { describe, expect, it } from "bun:test";
import { RiskManager } from "../src/application/mm/RiskManager";

describe("RiskManager", () => {
    it("tracks the high water mark upward", () => {
        const rm = new RiskManager(0.02);
        expect(rm.checkGlobalStopLoss(100)).toBeFalse();
        expect(rm.checkGlobalStopLoss(120)).toBeFalse();
        // Cair de 120 para 119 é 0,83% — abaixo do limite de 2%.
        expect(rm.checkGlobalStopLoss(119)).toBeFalse();
    });

    it("does not trip below the drawdown limit", () => {
        const rm = new RiskManager(0.02);
        rm.checkGlobalStopLoss(1000);
        expect(rm.checkGlobalStopLoss(985)).toBeFalse(); // -1,5%
        expect(rm.isKillSwitchEngaged).toBeFalse();
    });

    it("trips exactly at the limit", () => {
        const rm = new RiskManager(0.02);
        rm.checkGlobalStopLoss(1000);
        expect(rm.checkGlobalStopLoss(980)).toBeTrue(); // -2,0%
        expect(rm.isKillSwitchEngaged).toBeTrue();
    });

    it("is one-way: recovering wealth does not re-arm the engine", () => {
        const rm = new RiskManager(0.02);
        rm.checkGlobalStopLoss(1000);
        rm.checkGlobalStopLoss(900);
        expect(rm.isKillSwitchEngaged).toBeTrue();

        // Por projeto não existe reset: religar exige intervenção humana. Se isto passar a
        // devolver false, o bot volta a operar sozinho depois de um stop — que é
        // exatamente o comportamento que o kill switch existe para impedir.
        expect(rm.checkGlobalStopLoss(2000)).toBeTrue();
        expect(rm.isKillSwitchEngaged).toBeTrue();
    });

    it("honors the constructor override over the default", () => {
        const tight = new RiskManager(0.005);
        tight.checkGlobalStopLoss(1000);
        expect(tight.checkGlobalStopLoss(994)).toBeTrue(); // -0,6% > 0,5%

        const loose = new RiskManager(0.10);
        loose.checkGlobalStopLoss(1000);
        expect(loose.checkGlobalStopLoss(994)).toBeFalse();
    });

    it("defaults to a 2% limit when no override is given", () => {
        const rm = new RiskManager();
        expect(rm.MAX_DRAWDOWN_PCT).toBe(0.02);
    });
});
