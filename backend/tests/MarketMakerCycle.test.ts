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
});
