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
    async cancelOrder() { return {} as any; }
    async cancelAllOrders() {}
    canExecuteBatch() { return true; }
    logError() {}
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

    it("should keep the active order if price deviation is within tolerance and age < 10s", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 1; 
        im.quoteBalance = 60000;
        
        im.getQuotes = () => ({
            bids: [{ price: 60000, amountFactor: 1.0 }, { price: 59900, amountFactor: 1.0 }, { price: 59800, amountFactor: 1.0 }],
            asks: [{ price: 60010, amountFactor: 1.0 }, { price: 60020, amountFactor: 1.0 }, { price: 60030, amountFactor: 1.0 }],
            bidEnabled: true, askEnabled: true, q: 0,
            reservationPrice: 60005, effectiveSpread: 0.001, minSpreadFloor: 0.0005,
            bidDistancePct: 0.01, askDistancePct: 0.01, bidDistanceAbs: 1, askDistanceAbs: 1
        });

        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        cycle.lotConfig = { mode: "FIXED", value: 50 };

        // Mock an active order that is 5 seconds old, with price 60001
        // The new targetBid is 60000. Deviation = |60001 - 60000| / 60000 = 1/60000 = 0.0016% < 0.05%
        cycle.activeBuyOrders[0] = { orderId: "123", symbol: "BTCUSDT", side: "BUY", price: 60001, qty: 1, timestamp: Date.now() - 5000 };
        
        const cancelSpy = spyOn(executor, "cancelOrder");
        const buySpy = spyOn(executor, "executeMakerBuy");
        
        const tick = new Tick(pair, [{ price: new Amount(60010), qty: new Amount(1) }], [{ price: new Amount(60005), qty: new Amount(1) }]);
        stateManager.updateState(tick);

        await cycle.executeTick(pair);
        
        // Should NOT cancel the existing order
        expect(cancelSpy).not.toHaveBeenCalled();
        // Since L0 wasn't canceled (locked = 60001), and balance is 60000, L1 and L2 will be blocked!
        expect(buySpy).toHaveBeenCalledTimes(0);
    });

    it("should cancel and replace the order if price deviation exceeds tolerance (0.05%)", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 1; 
        im.quoteBalance = 60000;
        
        im.getQuotes = () => ({
            bids: [{ price: 60000, amountFactor: 1.0 }, { price: 59900, amountFactor: 1.0 }, { price: 59800, amountFactor: 1.0 }],
            asks: [{ price: 60010, amountFactor: 1.0 }, { price: 60020, amountFactor: 1.0 }, { price: 60030, amountFactor: 1.0 }],
            bidEnabled: true, askEnabled: true, q: 0,
            reservationPrice: 60005, effectiveSpread: 0.001, minSpreadFloor: 0.0005,
            bidDistancePct: 0.01, askDistancePct: 0.01, bidDistanceAbs: 1, askDistanceAbs: 1
        });

        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        cycle.lotConfig = { mode: "FIXED", value: 50 };

        // Mock an active order that is 5 seconds old, with price 60100
        // The new targetBid is 60000. Deviation = |60100 - 60000| / 60000 = 100/60000 = 0.16% > 0.05%
        cycle.activeBuyOrders[0] = { orderId: "123", symbol: "BTCUSDT", side: "BUY", price: 60100, qty: 1, timestamp: Date.now() - 5000 };
        
        const cancelSpy = spyOn(executor, "cancelOrder");
        const buySpy = spyOn(executor, "executeMakerBuy");
        
        const tick = new Tick(pair, [{ price: new Amount(60010), qty: new Amount(1) }], [{ price: new Amount(60005), qty: new Amount(1) }]);
        stateManager.updateState(tick);

        await cycle.executeTick(pair);
        
        // Should cancel the existing order because of price deviation
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        // L0 is cleared, so L0, L1, and L2 should be placed
        expect(buySpy).toHaveBeenCalledTimes(3); 
    });

    it("should cancel and replace the order if it is older than 10 seconds", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 1; 
        im.quoteBalance = 60000;
        
        im.getQuotes = () => ({
            bids: [{ price: 60000, amountFactor: 1.0 }, { price: 59900, amountFactor: 1.0 }, { price: 59800, amountFactor: 1.0 }],
            asks: [{ price: 60010, amountFactor: 1.0 }, { price: 60020, amountFactor: 1.0 }, { price: 60030, amountFactor: 1.0 }],
            bidEnabled: true, askEnabled: true, q: 0,
            reservationPrice: 60005, effectiveSpread: 0.001, minSpreadFloor: 0.0005,
            bidDistancePct: 0.01, askDistancePct: 0.01, bidDistanceAbs: 1, askDistanceAbs: 1
        });

        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        cycle.lotConfig = { mode: "FIXED", value: 50 };

        // Mock an active order with PERFECT price (60000) but 11 seconds old
        cycle.activeBuyOrders[0] = { orderId: "123", symbol: "BTCUSDT", side: "BUY", price: 60000, qty: 1, timestamp: Date.now() - 11000 };
        
        const cancelSpy = spyOn(executor, "cancelOrder");
        const buySpy = spyOn(executor, "executeMakerBuy");
        
        const tick = new Tick(pair, [{ price: new Amount(60010), qty: new Amount(1) }], [{ price: new Amount(60005), qty: new Amount(1) }]);
        stateManager.updateState(tick);

        await cycle.executeTick(pair);
        
        // Should cancel the existing order because of age
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(buySpy).toHaveBeenCalledTimes(3); 
    });
});
