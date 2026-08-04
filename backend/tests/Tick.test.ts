import { describe, expect, it } from "bun:test";
import { Tick, Level } from "../src/domain/valueObjects/Tick";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Amount } from "../src/domain/valueObjects/Amount";

describe("Tick", () => {
    const pair = new Pair(new Currency("BTC"), new Currency("USDT"));

    it("should identify correct pair", () => {
        const tick = new Tick(pair, [], []);
        expect(tick.isForPair(pair)).toBeTrue();
        expect(tick.isForPair(new Pair(new Currency("ETH"), new Currency("USDT")))).toBeFalse();
    });

    it("should calculate mid price correctly", () => {
        const asks: Level[] = [{ price: new Amount(100), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(90), qty: new Amount(1) }];
        const tick = new Tick(pair, asks, bids);
        
        let mid = 0;
        tick.getMidPrice()?.apply(v => mid = v);
        expect(mid).toBe(95);
    });

    it("should convert buy correctly using ask price", () => {
        const asks: Level[] = [{ price: new Amount(100), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(90), qty: new Amount(1) }];
        const tick = new Tick(pair, asks, bids);
        
        let boughtBase = 0;
        tick.convertBuy(new Amount(500)).apply(v => boughtBase = v); // spend 500 USDT, price is 100
        expect(boughtBase).toBe(5);
    });

    it("should convert sell correctly using bid price", () => {
        const asks: Level[] = [{ price: new Amount(100), qty: new Amount(1) }];
        const bids: Level[] = [{ price: new Amount(90), qty: new Amount(1) }];
        const tick = new Tick(pair, asks, bids);
        
        let soldQuote = 0;
        tick.convertSell(new Amount(5)).apply(v => soldQuote = v); // sell 5 BTC, price is 90
        expect(soldQuote).toBe(450);
    });

    it("should return undefined mid price if empty orderbook", () => {
        const tick = new Tick(pair, [], []);
        expect(tick.getMidPrice()).toBeUndefined();
    });
});
