import { describe, expect, it } from "bun:test";
import { InventoryManager } from "../src/application/mm/InventoryManager";

describe("InventoryManager", () => {
    it("should disable quoting if total wealth is zero", () => {
        const im = new InventoryManager();
        im.baseBalance = 0;
        im.quoteBalance = 0;
        
        const quotes = im.getQuotes(100);
        expect(quotes.bidEnabled).toBeFalse();
        expect(quotes.askEnabled).toBeFalse();
    });

    it("should generate symmetric quotes when inventory is perfectly balanced", () => {
        const im = new InventoryManager();
        im.baseBalance = 0.5;
        im.quoteBalance = 50; 
        
        const quotes = im.getQuotes(100);
        expect(quotes.q).toBe(0);
        expect(quotes.bidEnabled).toBeTrue();
        expect(quotes.askEnabled).toBeTrue();
        expect(quotes.bid).toBeLessThan(100);
        expect(quotes.ask).toBeGreaterThan(100);
    });

    it("should widen bid and tighten ask when long on base asset", () => {
        const im = new InventoryManager();
        im.baseBalance = 1;
        im.quoteBalance = 20;
        
        const balancedIm = new InventoryManager();
        balancedIm.baseBalance = 0.5;
        balancedIm.quoteBalance = 50;
        
        const feeRate = 0; // Disable fee floor for clear asymmetric test
        const longQuotes = im.getQuotes(100, feeRate);
        const balancedQuotes = balancedIm.getQuotes(100, feeRate);
        
        expect(longQuotes.q).toBeGreaterThan(0);
        expect(longQuotes.bid).toBeLessThan(balancedQuotes.bid);
        expect(longQuotes.ask).toBeLessThan(balancedQuotes.ask);
    });

    it("should tighten bid and widen ask when short on base asset", () => {
        const im = new InventoryManager();
        im.baseBalance = 0.2;
        im.quoteBalance = 100;
        
        const balancedIm = new InventoryManager();
        balancedIm.baseBalance = 0.5;
        balancedIm.quoteBalance = 50;
        
        const feeRate = 0;
        const shortQuotes = im.getQuotes(100, feeRate);
        const balancedQuotes = balancedIm.getQuotes(100, feeRate);
        
        expect(shortQuotes.q).toBeLessThan(0);
        expect(shortQuotes.bid).toBeGreaterThan(balancedQuotes.bid);
        expect(shortQuotes.ask).toBeGreaterThan(balancedQuotes.ask);
    });

    it("should disable bid if inventory skew exceeds max", () => {
        const im = new InventoryManager();
        im.baseBalance = 100; 
        im.quoteBalance = 1; 
        
        const quotes = im.getQuotes(100);
        expect(quotes.q).toBeGreaterThan(im.MAX_INVENTORY_SKEW);
        expect(quotes.bidEnabled).toBeFalse();
        expect(quotes.askEnabled).toBeTrue();
    });

    it("should adjust effective spread based on fee and volatility", () => {
        const im = new InventoryManager();
        im.baseBalance = 0.5;
        im.quoteBalance = 50; 
        
        const normalQuotes = im.getQuotes(100, 0.001, 0.001); 
        const highVolQuotes = im.getQuotes(100, 0.001, 0.005); 
        
        expect(highVolQuotes.effectiveSpread).toBeGreaterThan(normalQuotes.effectiveSpread);
    });
});
