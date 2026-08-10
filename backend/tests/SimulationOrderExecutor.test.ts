import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { SimulationOrderExecutor } from "../src/infrastructure/SimulationOrderExecutor";
import { StateManager } from "../src/domain/interfaces/StateManager";
import { BinancePrecisionFetcher } from "../src/infrastructure/BinancePrecisionFetcher";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Amount } from "../src/domain/valueObjects/Amount";
import { OrderBook } from "../src/domain/entities/OrderBook";
import { Tick } from "../src/domain/valueObjects/Tick";

class MockErrorLogRepository {
    public errors: any[] = [];
    public save(entry: any): void {
        this.errors.push(entry);
    }
}

class MockTransactionRepository {
    public transactions: any[] = [];
    public save(entry: any): void {
        this.transactions.push(entry);
    }
}

class MockPrecisionFetcher {
    getPriceTickSize(symbol: string): number {
        return 0.01;
    }
    getQuantityDecimals(symbol: string): number {
        return 2;
    }
    getMinNotional(symbol: string): number {
        return 0;
    }
}

describe.skip("SimulationOrderExecutor", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

    const createOrderBook = (midPrice: number) => {
        const book = new OrderBook();
        book.add(new Tick(
            pair, 
            [{ price: new Amount(midPrice + 1), qty: new Amount(10) }],
            [{ price: new Amount(midPrice - 1), qty: new Amount(10) }]
        ));
        return book;
    };

    let originalRandom: () => number;

    beforeEach(() => {
        originalRandom = Math.random;
        Math.random = () => 0.99; // Guarantee full fill
    });

    afterEach(() => {
        Math.random = originalRandom;
    });

    test("should set and return balances", () => {
        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            {} as unknown as StateManager
        );
        
        executor.setInitialBalances(2, 10000);
        
        expect(executor.baseBalance).toBe(2);
        expect(executor.quoteBalance).toBe(10000);
    });

    test("canExecuteBatch returns true", () => {
        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            {} as unknown as StateManager
        );
        expect(executor.canExecuteBatch(10)).toBe(true);
    });

    test("executeMakerBuy - successful execution", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(100)
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50000);

        const fill = await executor.executeMakerBuy(pair, new Amount(100), new Amount(100), 10);
    let success = fill !== null; // spend $100
        orderFill?.apply((executed, quote, avgPrice, success) => {
            expect(success).toBe(true);
            executed.apply(v => expect(v).toBeGreaterThan(0));
        });
        
        // Since we bought BTC, base should increase by > 0, quote should decrease
        expect(executor.baseBalance).toBeGreaterThan(5);
        expect(executor.quoteBalance).toBeLessThan(50000);
    });

    test("executeMakerBuy - fails due to insufficient quote balance", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(100)
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50); // Insufficient quote to buy 1 BTC at $100

        const fill = await executor.executeMakerBuy(pair, new Amount(100), new Amount(100), 10);
    let success = fill !== null; // want to spend $100
        orderFill?.apply((executed, quote, avgPrice, success) => expect(success).toBe(false));
    });

    test("executeMakerSell - successful execution", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(100)
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50000);

        const fill = await executor.executeMakerSell(pair, new Amount(1), new Amount(100), 10);
    let success = fill !== null;
        orderFill?.apply((executed, quote, avgPrice, success) => {
            expect(success).toBe(true);
            executed.apply(v => expect(v).toBeGreaterThan(0));
        });
        
        // Sold BTC, base should decrease, quote should increase
        expect(executor.baseBalance).toBeLessThan(5);
        expect(executor.quoteBalance).toBeGreaterThan(50000);
    });

    test("executeMakerSell - fails due to insufficient base balance", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(100)
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(0.5, 50000); // Insufficient base to sell 1 BTC

        const fill = await executor.executeMakerSell(pair, new Amount(1), new Amount(100), 10);
    let success = fill !== null;
        orderFill?.apply((executed, quote, avgPrice, success) => expect(success).toBe(false));
    });

    test("simulateOrder fails when midPrice is null (no orderbook)", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => new OrderBook() // Empty orderbook
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50000);

        const fill = await executor.executeMakerBuy(pair, new Amount(1), undefined, 10);
    let success = fill !== null; // No price provided
        orderFill?.apply((executed, quote, avgPrice, success) => expect(success).toBe(false));
    });
    
    test("simulateOrder returns failed when filledQty <= 0 due to truncation", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(100)
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50000);

        // precision is 2 decimals, so 0.001 becomes 0 after truncation
        const fill = await executor.executeMakerBuy(pair, new Amount(0.001), new Amount(100), 10);
    let success = fill !== null;
        orderFill?.apply((executed, quote, avgPrice, success) => expect(success).toBe(false));
    });

    test("simulateOrder falls back to mid price if targetPrice is not provided", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(120) // mid is 120
        } as unknown as StateManager;

        const errorLogger = new MockErrorLogRepository();
        const executor = new SimulationOrderExecutor(
            errorLogger as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50000);

        const fill = await executor.executeMakerBuy(pair, new Amount(100), undefined, 10);
    let success = fill !== null;
        orderFill?.apply((executed, quote, avgPrice, success) => {
            expect(success).toBe(true);
            avgPrice.apply(v => expect(v).toBeGreaterThan(0));
        });
    });
    
    test("simulateOrder tracks fees properly", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(100)
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50000);

        await executor.executeMakerBuy(pair, new Amount(100), new Amount(100), 10);
        expect(executor.totalFeesCollected).toBeGreaterThan(0);
    });

    test("cancelAllOrders successfully clears activeOrders", async () => {
        const mockStateManager = {
            retrieveOrderBook: () => createOrderBook(100)
        } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            mockStateManager
        );
        executor.setInitialBalances(5, 50000);

        // Place an order
        await executor.executeMakerBuy(pair, new Amount(100), new Amount(100), 10);
        
        // It shouldn't be empty
        expect(executor["activeOrders"].size).toBeGreaterThan(0);

        // Cancel all
        await executor.cancelAllOrders(pair);

        // It should be empty
        expect(executor["activeOrders"].size).toBe(0);
    });
});

// Regressão: o chamador (MarketMakerCycle) dimensiona a ordem para bater o notional
// mínimo da exchange ANTES do truncamento por stepSize. Como o truncamento sempre
// arredonda a quantidade para baixo, ele pode derrubar o notional de volta abaixo do
// mínimo — reproduzido ao vivo como -1013 "Filter failure: NOTIONAL". Estes testes usam
// as interfaces atuais (ActiveOrder | null, sem o .apply() do OrderFill legado acima) e
// não dependem da suíte desativada.
describe("SimulationOrderExecutor - minNotional enforcement", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("FDUSD"));

    class MinNotionalPrecisionFetcher {
        getPriceTickSize(_symbol: string): number { return 0.01; }
        getQuantityDecimals(_symbol: string): number { return 5; } // stepSize 0.00001, como BTCFDUSD
        getMinNotional(_symbol: string): number { return 5; }
    }

    const buildExecutor = () => new SimulationOrderExecutor(
        new MockErrorLogRepository() as any,
        new MockTransactionRepository() as any,
        new MinNotionalPrecisionFetcher() as unknown as BinancePrecisionFetcher,
        {} as unknown as StateManager
    );

    test("bumps a BUY quantity up when step-size truncation would fall below minNotional", async () => {
        const executor = buildExecutor();
        executor.setInitialBalances(0, 1000);

        // $5,00 exatos a $64.500: floor ingênuo ao stepSize dá 0,00007 BTC = $4,515,
        // abaixo do minNotional de $5. O executor deve arredondar para cima.
        const order = await executor.executeMakerBuy(pair, new Amount(5), new Amount(64500));

        expect(order).not.toBeNull();
        const notional = order!.qty * order!.price;
        expect(notional).toBeGreaterThanOrEqual(5);
    });

    test("bumps a SELL quantity up when step-size truncation would fall below minNotional", async () => {
        const executor = buildExecutor();
        executor.setInitialBalances(1, 0);

        const order = await executor.executeMakerSell(pair, new Amount(0.0000775), new Amount(64500));

        expect(order).not.toBeNull();
        const notional = order!.qty * order!.price;
        expect(notional).toBeGreaterThanOrEqual(5);
    });

    test("does not bump when the order already clears minNotional", async () => {
        const executor = buildExecutor();
        executor.setInitialBalances(0, 1000);

        const order = await executor.executeMakerBuy(pair, new Amount(100), new Amount(64500));

        expect(order).not.toBeNull();
        // 100 / 64500 truncado a 5 casas = 0.00155 — nenhum ajuste deveria ocorrer.
        expect(order!.qty).toBeCloseTo(0.00155, 10);
    });
});

/**
 * Bloco separado (e NÃO pulado) para as ordens a mercado. O describe acima está em
 * `.skip` desde antes destas mudanças; manter a cobertura nova fora dele evita que ela
 * nasça desligada junto.
 */
describe("SimulationOrderExecutor — ordens a mercado", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("FDUSD"));

    function make(bid: number, ask: number) {
        const book = new OrderBook();
        book.add(new Tick(
            pair,
            [{ price: new Amount(ask), qty: new Amount(10) }],
            [{ price: new Amount(bid), qty: new Amount(10) }]
        ));
        const stateManager = { retrieveOrderBook: () => book } as unknown as StateManager;

        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            stateManager
        );
        return executor;
    }

    test("market sell fills immediately at the bid and moves the virtual balances", async () => {
        const executor = make(99, 101);
        executor.setInitialBalances(1, 0);

        // Sem passar por evaluateFills: um taker consome liquidez, não espera fila.
        const fill = await executor.executeMarketSell(pair, new Amount(0.5));

        let qty = 0, price = 0, ok = false;
        fill.apply((q, _quote, p, success) => {
            q.apply(v => qty = v);
            p.apply(v => price = v);
            ok = success;
        });

        expect(ok).toBeTrue();
        expect(qty).toBeCloseTo(0.5, 8);
        expect(price).toBe(99);
        expect(executor.baseBalance).toBeCloseTo(0.5, 8);
        expect(executor.quoteBalance).toBeCloseTo(49.5, 8);
    });

    test("market buy fills at the ask", async () => {
        const executor = make(99, 101);
        executor.setInitialBalances(0, 202);

        const fill = await executor.executeMarketBuy(pair, new Amount(101));

        let price = 0;
        fill.apply((_q, _quote, p) => { p.apply(v => price = v); });
        expect(price).toBe(101);
        expect(executor.baseBalance).toBeGreaterThan(0);
    });

    test("refuses to sell more base than the virtual balance holds", async () => {
        const executor = make(99, 101);
        executor.setInitialBalances(0.1, 0);

        // Sem esta trava o simulador produziria saldo negativo e esconderia o -2010 que a
        // Binance real devolveria.
        const fill = await executor.executeMarketSell(pair, new Amount(5));

        let ok = true;
        fill.apply((_q, _quote, _p, success) => { ok = success; });
        expect(ok).toBeFalse();
        expect(executor.baseBalance).toBe(0.1);
    });

    test("fails cleanly when there is no orderbook", async () => {
        const executor = new SimulationOrderExecutor(
            new MockErrorLogRepository() as any,
            new MockTransactionRepository() as any,
            new MockPrecisionFetcher() as unknown as BinancePrecisionFetcher,
            { retrieveOrderBook: () => null } as unknown as StateManager
        );
        executor.setInitialBalances(1, 0);

        const fill = await executor.executeMarketSell(pair, new Amount(0.5));
        let ok = true;
        fill.apply((_q, _quote, _p, success) => { ok = success; });
        expect(ok).toBeFalse();
    });
});
