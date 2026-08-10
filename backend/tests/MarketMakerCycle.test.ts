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
import { OrderFill } from "../src/domain/valueObjects/OrderFill";
import { TimeProvider } from "../src/infrastructure/TimeProvider";

class MockExecutor implements OrderExecutor {
    async executeMakerBuy() { return {} as any; }
    async executeMakerSell() { return {} as any; }
    // Ordens a mercado devolvem OrderFill de verdade: os testes de flatten inspecionam o
    // resultado, e um `{} as any` faria o `.apply()` estourar em vez de falhar no assert.
    // Os parâmetros são declarados (mesmo sem uso) para que `spyOn(...).mock.calls` seja
    // tipado como [Pair, Amount] em vez de tupla vazia — é assim que os testes leem a
    // quantidade que o flatten pediu.
    async executeMarketBuy(_pair: Pair, _quoteAmount: Amount): Promise<OrderFill> { return OrderFill.failed(); }
    async executeMarketSell(_pair: Pair, _baseAmount: Amount): Promise<OrderFill> { return OrderFill.failed(); }
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
            bidVeto: null,
            askVeto: null,
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
            bidEnabled: true, askEnabled: true, bidVeto: null, askVeto: null, q: 0,
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
            bidEnabled: true, askEnabled: true, bidVeto: null, askVeto: null, q: 0,
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
        // ORDER_LEVELS = 1, so only L0 is replaced
        expect(buySpy).toHaveBeenCalledTimes(1);
    });

    it("should cancel and replace the order if it exceeds MAX_ORDER_AGE_MS", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 1; 
        im.quoteBalance = 60000;
        
        im.getQuotes = () => ({
            bids: [{ price: 60000, amountFactor: 1.0 }, { price: 59900, amountFactor: 1.0 }, { price: 59800, amountFactor: 1.0 }],
            asks: [{ price: 60010, amountFactor: 1.0 }, { price: 60020, amountFactor: 1.0 }, { price: 60030, amountFactor: 1.0 }],
            bidEnabled: true, askEnabled: true, bidVeto: null, askVeto: null, q: 0,
            reservationPrice: 60005, effectiveSpread: 0.001, minSpreadFloor: 0.0005,
            bidDistancePct: 0.01, askDistancePct: 0.01, bidDistanceAbs: 1, askDistanceAbs: 1
        });

        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        cycle.lotConfig = { mode: "FIXED", value: 50 };

        // Mock an active order with PERFECT price (60000) but older than MAX_ORDER_AGE_MS (60s)
        cycle.activeBuyOrders[0] = { orderId: "123", symbol: "BTCUSDT", side: "BUY", price: 60000, qty: 1, timestamp: Date.now() - 61000 };

        const cancelSpy = spyOn(executor, "cancelOrder");
        const buySpy = spyOn(executor, "executeMakerBuy");

        const tick = new Tick(pair, [{ price: new Amount(60010), qty: new Amount(1) }], [{ price: new Amount(60005), qty: new Amount(1) }]);
        stateManager.updateState(tick);

        await cycle.executeTick(pair);

        // Should cancel the existing order because of age
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(buySpy).toHaveBeenCalledTimes(1);
    });

    it("should not cancel a fresh order whose price is still within tolerance", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 1;
        im.quoteBalance = 60000;

        im.getQuotes = () => ({
            bids: [{ price: 60000, amountFactor: 1.0 }],
            asks: [{ price: 60010, amountFactor: 1.0 }],
            bidEnabled: true, askEnabled: true, bidVeto: null, askVeto: null, q: 0,
            reservationPrice: 60005, effectiveSpread: 0.001, minSpreadFloor: 0.0005,
            bidDistancePct: 0.01, askDistancePct: 0.01, bidDistanceAbs: 1, askDistanceAbs: 1
        });

        const executor = new MockExecutor();
        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        cycle.lotConfig = { mode: "FIXED", value: 50 };

        // Desvio de 1/60000 = 0.0017%, muito abaixo da tolerância; idade de 5s < 60s.
        cycle.activeBuyOrders[0] = { orderId: "123", symbol: "BTCUSDT", side: "BUY", price: 60001, qty: 1, timestamp: Date.now() - 5000 };

        const cancelSpy = spyOn(executor, "cancelOrder");

        const tick = new Tick(pair, [{ price: new Amount(60010), qty: new Amount(1) }], [{ price: new Amount(60005), qty: new Amount(1) }]);
        stateManager.updateState(tick);

        await cycle.executeTick(pair);

        // Manter a ordem parada é o que preserva prioridade de fila.
        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it("should not leave an optimistic lock behind when placement throws", async () => {
        const stateManager = new LocalStateManager();
        stateManager.registerPair(pair);

        const im = new InventoryManager();
        im.baseBalance = 0;
        im.quoteBalance = 60000;

        im.getQuotes = () => ({
            bids: [{ price: 60000, amountFactor: 1.0 }],
            asks: [{ price: 60010, amountFactor: 1.0 }],
            bidEnabled: true, askEnabled: true, bidVeto: null, askVeto: null, q: 0,
            reservationPrice: 60005, effectiveSpread: 0.001, minSpreadFloor: 0.0005,
            bidDistancePct: 0.01, askDistancePct: 0.01, bidDistanceAbs: 1, askDistanceAbs: 1
        });

        const executor = new MockExecutor();
        executor.executeMakerBuy = async () => { throw new Error("WS timeout"); };

        const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
        const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
        cycle.lotConfig = { mode: "FIXED", value: 50 };

        const cancelSpy = spyOn(executor, "cancelOrder");

        const tick = new Tick(pair, [{ price: new Amount(60010), qty: new Amount(1) }], [{ price: new Amount(60005), qty: new Amount(1) }]);
        stateManager.updateState(tick);

        await cycle.executeTick(pair);

        // O lock otimista não pode sobreviver à exceção: se sobreviver, seu notional
        // desconta saldo de um pedido inexistente e ele acaba sendo enviado a
        // cancelOrder com um id que a Binance rejeita (-1100).
        expect(cycle.activeBuyOrders[0]).toBeNull();

        // Segunda passada: nada a cancelar, e a colocação é tentada de novo.
        await cycle.executeTick(pair);
        expect(cancelSpy).not.toHaveBeenCalled();
    });

    describe("flattenInventory", () => {
        /** Um OrderFill bem-sucedido, para o executor devolver algo inspecionável. */
        function filled(qty: number, price: number): OrderFill {
            return new OrderFill(new Amount(qty), new Amount(qty * price), new Amount(price), true);
        }

        function setup() {
            const stateManager = new LocalStateManager();
            const im = new InventoryManager();
            const executor = new MockExecutor();
            const cb = { shouldPause: () => false } as unknown as CircuitBreaker;
            const cycle = new MarketMakerCycle(stateManager, cb, im, executor);
            return { cycle, im, executor };
        }

        it("market-sells the excess above the target", async () => {
            const { cycle, im, executor } = setup();
            // 1 BTC a 100 = 100 de base, 0 em quote. Alvo 25% de 100 => 25.
            // Excedente = 75 => vender 0,75 BTC.
            im.baseBalance = 1;
            im.quoteBalance = 0;

            const sellSpy = spyOn(executor, "executeMarketSell")
                .mockResolvedValue(filled(0.75, 100));

            await cycle.flattenInventory(pair, 100, 10, 0.25);

            expect(sellSpy).toHaveBeenCalledTimes(1);
            let soldQty = 0;
            sellSpy.mock.calls[0]![1].apply(v => soldQty = v);
            expect(soldQty).toBeCloseTo(0.75, 8);
        });

        it("liquidates everything when the target is zero (kill switch path)", async () => {
            const { cycle, im, executor } = setup();
            im.baseBalance = 1;
            im.quoteBalance = 0;

            const sellSpy = spyOn(executor, "executeMarketSell")
                .mockResolvedValue(filled(1, 100));

            await cycle.flattenInventory(pair, 100, 10, 0);

            let soldQty = 0;
            sellSpy.mock.calls[0]![1].apply(v => soldQty = v);
            expect(soldQty).toBeCloseTo(1, 8);
        });

        /**
         * Trava de projeto: o flatten SÓ VENDE. Quem o chama é o kill switch de drawdown ou
         * a defesa de queda — comprar BTC nesse momento seria aumentar risco sob o nome de
         * "rebalancear".
         */
        it("NEVER buys when inventory is below target", async () => {
            const { cycle, im, executor } = setup();
            im.baseBalance = 0.01;   // 1 de valor
            im.quoteBalance = 99;    // bem abaixo do alvo de 25%

            const sellSpy = spyOn(executor, "executeMarketSell");
            const buySpy = spyOn(executor, "executeMarketBuy");

            await cycle.flattenInventory(pair, 100, 10, 0.25);

            expect(sellSpy).not.toHaveBeenCalled();
            expect(buySpy).not.toHaveBeenCalled();
        });

        it("does nothing when the excess is below the exchange minimum", async () => {
            const { cycle, im, executor } = setup();
            // Excedente de ~5, abaixo do minNotional de 10: a exchange rejeitaria.
            im.baseBalance = 0.3;
            im.quoteBalance = 70;

            const sellSpy = spyOn(executor, "executeMarketSell");
            await cycle.flattenInventory(pair, 100, 10, 0.25);

            expect(sellSpy).not.toHaveBeenCalled();
        });

        it("cancels hanging orders too, not just active ones", async () => {
            const { cycle, im, executor } = setup();
            im.baseBalance = 1;
            im.quoteBalance = 0;
            spyOn(executor, "executeMarketSell").mockResolvedValue(filled(0.75, 100));

            // BTC preso numa hanging order faz a venda a mercado falhar com -2010.
            cycle.hangingSellOrders.push({
                orderId: "999", symbol: "BTCUSDT", side: "SELL",
                price: 105, qty: 0.5, timestamp: TimeProvider.now()
            });
            const cancelSpy = spyOn(executor, "cancelOrder");

            await cycle.flattenInventory(pair, 100, 10, 0.25);

            expect(cancelSpy).toHaveBeenCalledTimes(1);
            expect(cycle.hangingSellOrders.length).toBe(0);
        });

        it("never asks to sell more base than it holds", async () => {
            const { cycle, im, executor } = setup();
            im.baseBalance = 0.5;
            im.quoteBalance = 0;
            const sellSpy = spyOn(executor, "executeMarketSell")
                .mockResolvedValue(filled(0.5, 100));

            await cycle.flattenInventory(pair, 100, 10, 0);

            let soldQty = 0;
            sellSpy.mock.calls[0]![1].apply(v => soldQty = v);
            expect(soldQty).toBeLessThanOrEqual(0.5);
        });

        it("survives an executor exception without throwing", async () => {
            const { cycle, im, executor } = setup();
            im.baseBalance = 1;
            im.quoteBalance = 0;
            spyOn(executor, "executeMarketSell").mockRejectedValue(new Error("network down"));
            const logSpy = spyOn(executor, "logError");

            // Se isto lançar, o kill switch morre no meio e o motor nunca chega a parar.
            await cycle.flattenInventory(pair, 100, 10, 0);

            expect(logSpy).toHaveBeenCalled();
        });

        it("logs when the market sell does not fill", async () => {
            const { cycle, im, executor } = setup();
            im.baseBalance = 1;
            im.quoteBalance = 0;
            spyOn(executor, "executeMarketSell").mockResolvedValue(OrderFill.failed());
            const logSpy = spyOn(executor, "logError");

            await cycle.flattenInventory(pair, 100, 10, 0);

            expect(logSpy).toHaveBeenCalled();
        });

        it("does not fire automatically while trend auto-flatten is disabled", async () => {
            const { cycle, executor } = setup();
            const sellSpy = spyOn(executor, "executeMarketSell");

            // Default é desligado: liquidação por tendência é taker e precisa de validação
            // da taxa real antes de rodar sozinha.
            expect(cycle.TREND_FLATTEN_ENABLED).toBeFalse();
            await cycle.executeTick(pair, 0, 0, true, 1.5, 10, -0.05, 0.004, 0.01);

            expect(sellSpy).not.toHaveBeenCalled();
        });
    });
});
