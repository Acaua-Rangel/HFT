import { describe, expect, it } from "bun:test";
import { LiquidityMonitor } from "../src/application/mm/LiquidityMonitor";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Tick, Level } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";

describe("LiquidityMonitor", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

    it("should pause if there is no orderbook", () => {
        const stateManager = new LocalStateManager();
        const monitor = new LiquidityMonitor(stateManager);
        expect(monitor.shouldPause(pair)).toBeTrue();
    });

    it("should pause if liquidity is below threshold in top 3 levels", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new LiquidityMonitor(stateManager);
        
        // Very low liquidity in top 3 levels
        const asks: Level[] = [
            { price: new Amount(101), qty: new Amount(0.01) },
            { price: new Amount(102), qty: new Amount(0.01) },
            { price: new Amount(103), qty: new Amount(0.01) }
        ]; // 1.01 + 1.02 + 1.03 = ~3 Notional Value (< 20)
        
        const bids: Level[] = [
            { price: new Amount(100), qty: new Amount(0.01) },
            { price: new Amount(99), qty: new Amount(0.01) },
            { price: new Amount(98), qty: new Amount(0.01) }
        ];
        
        stateManager.updateState(new Tick(pair, asks, bids));
        expect(monitor.shouldPause(pair)).toBeTrue();
    });

    it("should not pause if liquidity is above threshold within top 3 levels even if top level is thin", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new LiquidityMonitor(stateManager);
        
        const asks: Level[] = [
            { price: new Amount(101), qty: new Amount(0.01) }, // thin top (1.01 Notional)
            { price: new Amount(102), qty: new Amount(1) },    // deep 2nd (102 Notional)
            { price: new Amount(103), qty: new Amount(1) }     // deep 3rd
        ];
        
        const bids: Level[] = [
            { price: new Amount(100), qty: new Amount(0.01) }, // thin top
            { price: new Amount(99), qty: new Amount(1) },     // deep 2nd
            { price: new Amount(98), qty: new Amount(1) }
        ];
        
        stateManager.updateState(new Tick(pair, asks, bids));
        
        // Sum is > 20, so it should NOT pause, proving the multi-level logic works
        expect(monitor.shouldPause(pair)).toBeFalse();
    });
});
