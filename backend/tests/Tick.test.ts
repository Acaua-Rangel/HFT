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

    it("should extract top N levels correctly", () => {
        const asks: Level[] = [
            { price: new Amount(100), qty: new Amount(1) },
            { price: new Amount(101), qty: new Amount(2) },
            { price: new Amount(102), qty: new Amount(3) }
        ];
        const bids: Level[] = [
            { price: new Amount(90), qty: new Amount(1) },
            { price: new Amount(89), qty: new Amount(2) },
            { price: new Amount(88), qty: new Amount(3) }
        ];
        const tick = new Tick(pair, asks, bids);
        
        let topAsks: Level[] = [];
        tick.applyTopNAsks(2, (levels) => { topAsks = levels; });
        expect(topAsks.length).toBe(2);
        
        let topAskPrices = 0;
        topAsks.forEach(l => l.price.apply(v => topAskPrices += v));
        expect(topAskPrices).toBe(201); // 100 + 101

        let topBids: Level[] = [];
        tick.applyTopNBids(2, (levels) => { topBids = levels; });
        expect(topBids.length).toBe(2);
        
        let topBidPrices = 0;
        topBids.forEach(l => l.price.apply(v => topBidPrices += v));
        expect(topBidPrices).toBe(179); // 90 + 89
    });
});
