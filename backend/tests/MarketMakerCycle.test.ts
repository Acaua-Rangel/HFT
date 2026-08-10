import { describe, expect, it, spyOn } from "bun:test";
import { MarketMakerCycle } from "../src/application/mm/MarketMakerCycle";
import { CircuitBreaker } from "../src/application/mm/CircuitBreaker";
import { InventoryManager } from "../src/application/mm/InventoryManager";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Tick, Level } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";
import { OrderExecutor } from "../src/domain/interfaces/OrderExecutor";

class MockExecutor implements OrderExecutor {
    async executeMakerBuy() { return {} as any; }
    async executeMakerSell() { return {} as any; }
    async executeMarketBuy() { return {} as any; }
    async executeMarketSell() { return {} as any; }
    canExecuteBatch() { return true; }
}

describe("MarketMakerCycle", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

    it("should not execute if circuit breaker pauses", async () => {
        const stateManager = new LocalStateManager();
        const im = new InventoryManager();
        const executor = new MockExecutor();
        
        const cb = { shouldPause: () => true } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        
        const buySpy = spyOn(executor, "executeMakerBuy");
        await cycle.executeTick(pair);
        
        expect(buySpy).not.toHaveBeenCalled();
    });

    it("should not execute if orderbook is missing", async () => {
        const stateManager = new LocalStateManager();
        const im = new InventoryManager();
        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        const buySpy = spyOn(executor, "executeMakerBuy");
        
        await cycle.executeTick(pair);
        expect(buySpy).not.toHaveBeenCalled();
    });

    it("should place buy and sell orders if conditions are met", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 1; // 1 BTC
        im.quoteBalance = 60000; // 60k USDT
        
        const asks: Level[] = [{ price: new Amount(60001), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(60000), qty: new Amount(1) }];
        stateManager.updateState(new Tick(pair, asks, bids));

        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        const buySpy = spyOn(executor, "executeMakerBuy");
        const sellSpy = spyOn(executor, "executeMakerSell");
        
        await cycle.executeTick(pair);
        
        expect(buySpy).toHaveBeenCalled();
        expect(sellSpy).toHaveBeenCalled();
    });

    it("should respect optimistic locking and prevent over-allocation", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 1; 
        im.quoteBalance = 60; // Only enough for the first level (50)
        
        im.getQuotes = () => ({
            bids: [{ price: 60000, amountFactor: 1.0 }, { price: 59990, amountFactor: 1.5 }, { price: 59980, amountFactor: 2.0 }],
            asks: [{ price: 60001, amountFactor: 1.0 }, { price: 60010, amountFactor: 1.5 }, { price: 60020, amountFactor: 2.0 }],
            bidEnabled: true,
            askEnabled: true,
            q: 0,
            reservationPrice: 60000.5,
            effectiveSpread: 0.001,
            minSpreadFloor: 0.0005,
            bidDistancePct: 0.01, askDistancePct: 0.01, bidDistanceAbs: 1, askDistanceAbs: 1
        });

        const asks: Level[] = [{ price: new Amount(60001), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(60000), qty: new Amount(1) }];
        stateManager.updateState(new Tick(pair, asks, bids));

        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        
        cycle.lotConfig = { mode: "FIXED", value: 50 }; // baseLotQuote is 50, q=0 means buyLotQuote=50
        
        const buySpy = spyOn(executor, "executeMakerBuy");
        await cycle.executeTick(pair);
        
        // Should only be called once because the optimistic lock of 50 will prevent the next 75 order (50 + 75 > 60)
        expect(buySpy).toHaveBeenCalledTimes(1);
    });
});
