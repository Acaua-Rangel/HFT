import { describe, expect, it } from "bun:test";
import { Amount } from "../src/domain/valueObjects/Amount";

describe("Amount", () => {
    it("should store and apply value correctly", () => {
        const amount = new Amount(100.5);
        let captured = 0;
        amount.apply(val => captured = val);
        expect(captured).toBe(100.5);
    });


});
