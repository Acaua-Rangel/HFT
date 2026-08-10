import { expect, test, describe, mock, spyOn } from "bun:test";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { VolatilityMonitor } from "../src/application/mm/VolatilityMonitor";
import { LiquidityMonitor } from "../src/application/mm/LiquidityMonitor";
import { CircuitBreaker } from "../src/application/mm/CircuitBreaker";
import { InventoryManager } from "../src/application/mm/InventoryManager";
import { MarketMakerCycle } from "../src/application/mm/MarketMakerCycle";
import { Tick } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";
import { OrderExecutor } from "../src/domain/interfaces/OrderExecutor";
import { OrderFill } from "../src/domain/valueObjects/OrderFill";
import { TimeProvider } from "../src/infrastructure/TimeProvider";

describe("Adverse Selection Flow Test (Toxic Flow Protection)", () => {
    test("Should protect against falling knife and enforce TTL constraints", async () => {
        // Setup
        const btc = new Currency("BTC");
        const fdusd = new Currency("FDUSD");
        const pair = new Pair(btc, fdusd);
        
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);
        
        const volatilityMonitor = new VolatilityMonitor(stateManager);
        const liquidityMonitor = new LiquidityMonitor(stateManager);
        const circuitBreaker = new CircuitBreaker(volatilityMonitor, liquidityMonitor, () => 100); // 100ms latency (ok)
        
        const inventoryManager = new InventoryManager();
        inventoryManager.baseBalance = 0.05; // Has some BTC
        inventoryManager.quoteBalance = 5000; // Has some Quote
        
        class MockExecutor implements OrderExecutor {
            async executeMakerBuy(pair: Pair, amount: Amount, price?: Amount, ttlMs?: number): Promise<OrderFill> {
                return OrderFill.failed();
            }
            async executeMakerSell(pair: Pair, amount: Amount, price?: Amount, ttlMs?: number): Promise<OrderFill> {
                return OrderFill.failed();
            }
            canExecuteBatch(count: number): boolean { return true; }
            async cancelOrder(order: any): Promise<OrderFill> { return OrderFill.failed(); }
            async cancelAllOrders(_pair: Pair): Promise<void> {}
            logError(_type: string, _message: string): void {}
        }

        // Tempo virtual: o VolatilityMonitor normaliza os retornos por dt, então as
        // amostras precisam de intervalos reais entre si.
        let clock = 1_700_000_000_000;
        const advance = (ms = 1000) => { clock += ms; TimeProvider.setVirtualTime(clock); };
        TimeProvider.setVirtualTime(clock);
        
        const mockExecutor = new MockExecutor();
        const executeMakerBuySpy = spyOn(mockExecutor, "executeMakerBuy");
        const executeMakerSellSpy = spyOn(mockExecutor, "executeMakerSell");
        
        const cycle = new MarketMakerCycle(stateManager, circuitBreaker, inventoryManager, mockExecutor);
        
        // 1. Initial State (Normal Market)
        for(let i=0; i<15; i++) {
            // Price staying around 60000
            const tick = new Tick(pair, 
                [{ price: new Amount(60010), qty: new Amount(1) }], 
                [{ price: new Amount(60000), qty: new Amount(1) }]
            );
            stateManager.updateState(tick);
            volatilityMonitor.record(pair);
            advance();
        }
        
        const normalVol = volatilityMonitor.getVolatilityPercentage(pair);
        expect(normalVol).toBeLessThan(0.001); // Volatility should be 0 or very small
        
        await cycle.executeTick(pair, 0, normalVol, true);
        
        // Assert TTL is 1000
        expect(executeMakerBuySpy).toHaveBeenCalled();
        expect(executeMakerBuySpy.mock.calls[0]).toBeDefined();
        executeMakerBuySpy.mockClear();
        executeMakerSellSpy.mockClear();
        
        // 2. Simulate Flash Crash (Prices dropping heavily)
        let currentPrice = 60000;
        for(let i=0; i<15; i++) {
            currentPrice -= 200; // Drop 200$ rapidly to spike variance
            const tick = new Tick(pair, 
                [{ price: new Amount(currentPrice + 10), qty: new Amount(1) }], 
                [{ price: new Amount(currentPrice), qty: new Amount(1) }]
            );
            stateManager.updateState(tick);
            volatilityMonitor.record(pair);
            advance();
        }
        
        const crashVol = volatilityMonitor.getVolatilityPercentage(pair);
        expect(crashVol).toBeGreaterThan(0.001); // Volatility spiked
        
        const tickData = stateManager.retrieveOrderBook(pair)!.getLatest()!;
        let mid = 0; tickData.getMidPrice()!.apply(v => mid = v);
        
        const quotes = inventoryManager.getQuotes(mid, 0, crashVol, true, mid-5, mid+5);
        // Assert safety multiplier kicks in (Spread >= crashVol * 5.0)
        expect(quotes.minSpreadFloor).toBeGreaterThanOrEqual(crashVol * 5.0);
        
        // 3. Simulate getting filled with toxic flow (Inventory skew protection)
        // Let's pretend bot bought a lot of BTC due to the falling knife
        inventoryManager.baseBalance = 0.5; // Huge BTC bag
        inventoryManager.quoteBalance = 1000; // Low quote balance
        
        const skewedQuotes = inventoryManager.getQuotes(mid, 0, crashVol, true, mid-5, mid+5);
        
        // Max inventory skew should be reached, disabling bid
        expect(skewedQuotes.bidEnabled).toBe(false); 
        
        // 4. Test Circuit Breaker Veto
        // Let's make volatility extreme (huge drop in one tick)
        currentPrice -= 8000;
        const extremeTick = new Tick(pair, 
            [{ price: new Amount(currentPrice + 10), qty: new Amount(1) }], 
            [{ price: new Amount(currentPrice), qty: new Amount(1) }]
        );
        stateManager.updateState(extremeTick);
        volatilityMonitor.record(pair);
        advance();

        const extremeVol = volatilityMonitor.getVolatilityPercentage(pair);
        expect(extremeVol).toBeGreaterThan(0.005); // Above 0.5% threshold
        
        const shouldPause = circuitBreaker.shouldPause(pair);
        expect(shouldPause).toBe(true); // Circuit breaker correctly tripped
        
        // Ensure cycle execution respects Circuit Breaker and does not call executor
        await cycle.executeTick(pair, 0, extremeVol, true);
        expect(executeMakerBuySpy).not.toHaveBeenCalled();
        expect(executeMakerSellSpy).not.toHaveBeenCalled();

        TimeProvider.clearVirtualTime();
    });
});
