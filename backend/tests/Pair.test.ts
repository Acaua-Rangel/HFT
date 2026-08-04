import { describe, expect, it } from "bun:test";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";

describe("Pair", () => {
    it("should format string correctly", () => {
        const pair = new Pair(new Currency("BTC"), new Currency("BRL"));
        expect(pair.toString()).toBe("BTC/BRL");
    });

    it("should check equality", () => {
        const p1 = new Pair(new Currency("BTC"), new Currency("BRL"));
        const p2 = new Pair(new Currency("BTC"), new Currency("BRL"));
        const p3 = new Pair(new Currency("ETH"), new Currency("BRL"));

        expect(p1.isEquals(p2)).toBeTrue();
        expect(p1.isEquals(p3)).toBeFalse();
    });

    it("should format for binance stream", () => {
        const pair = new Pair(new Currency("BTC"), new Currency("BRL"));
        let stream = "";
        pair.applyBinanceStreamFormat(s => stream = s);
        expect(stream).toBe("btcbrl@depth20@100ms");
    });

    it("should format for binance symbol", () => {
        const pair = new Pair(new Currency("BTC"), new Currency("BRL"));
        let sym = "";
        pair.applyBinanceSymbol(s => sym = s);
        expect(sym).toBe("BTCBRL");
    });
});
