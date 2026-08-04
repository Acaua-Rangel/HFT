import { describe, expect, it } from "bun:test";
import { Currency } from "../src/domain/valueObjects/Currency";

describe("Currency", () => {
    it("should store and apply symbol correctly", () => {
        const currency = new Currency("BTC");
        let captured = "";
        currency.applySymbol(sym => captured = sym);
        expect(captured).toBe("BTC");
    });

    it("should check equality correctly", () => {
        const c1 = new Currency("BTC");
        const c2 = new Currency("BTC");
        const c3 = new Currency("USDT");

        expect(c1.isEquals(c2)).toBeTrue();
        expect(c1.isEquals(c3)).toBeFalse();
    });
});
