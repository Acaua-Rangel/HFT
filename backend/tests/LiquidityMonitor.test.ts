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

    it("should pause if liquidity is below threshold", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new LiquidityMonitor(stateManager);
        
        const asks: Level[] = [{ price: new Amount(101), qty: new Amount(0.1) }];
        const bids: Level[] = [{ price: new Amount(100), qty: new Amount(0.1) }];
        
        stateManager.updateState(new Tick(pair, asks, bids));

        expect(monitor.shouldPause(pair)).toBeTrue();
    });

    it("should not pause if liquidity is above threshold", () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        const monitor = new LiquidityMonitor(stateManager);
        
        const asks: Level[] = [{ price: new Amount(101), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(100), qty: new Amount(1) }];
        
        stateManager.updateState(new Tick(pair, asks, bids));

        expect(monitor.shouldPause(pair)).toBeFalse();
    });
});
