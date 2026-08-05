import { describe, it, expect } from "bun:test";
import { Fee } from "../src/domain/valueObjects/Fee";
import { Amount } from "../src/domain/valueObjects/Amount";

describe("Fee Value Object", () => {
  it("should calculate standard fee correctly", () => {
    const fee = new Fee(new Amount(0.001)); // 0.1% fee
    const gross = new Amount(1000);
    
    const discount = fee.calculateDiscount(gross);
    expect((discount as any).value).toBe(1); // 0.1% of 1000 is 1
    
    const net = fee.deductFrom(gross);
    expect((net as any).value).toBe(999);
  });


});
