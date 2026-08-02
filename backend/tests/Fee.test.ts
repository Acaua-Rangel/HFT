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

  it("should apply 25% BNB discount and not deduct from base asset", () => {
    const standardFee = new Fee(new Amount(0.001)); // 0.1% fee
    const bnbFee = standardFee.withBnbDiscount(); // Should be 0.075% fee
    
    expect(bnbFee.isBnbPaid).toBe(true);

    const gross = new Amount(1000);
    
    const discount = bnbFee.calculateDiscount(gross);
    expect((discount as any).value).toBe(0.75); // 0.075% of 1000 is 0.75
    
    const net = bnbFee.deductFrom(gross);
    // Since it's paid in BNB, the base asset should remain untouched
    expect((net as any).value).toBe(1000);
  });

  it("should handle zero fees", () => {
    const fee = new Fee(new Amount(0));
    const gross = new Amount(100);
    
    expect((fee.calculateDiscount(gross) as any).value).toBe(0);
    expect((fee.deductFrom(gross) as any).value).toBe(100);
    
    const bnbFee = fee.withBnbDiscount();
    expect((bnbFee.calculateDiscount(gross) as any).value).toBe(0);
    expect((bnbFee.deductFrom(gross) as any).value).toBe(100);
  });
});
