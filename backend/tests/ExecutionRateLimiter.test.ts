import { describe, expect, it } from "bun:test";
import { ExecutionRateLimiter } from "../src/infrastructure/ExecutionRateLimiter";

describe("ExecutionRateLimiter", () => {
    it("should have capacity initially", () => {
        const limiter = new ExecutionRateLimiter(5, 1000);
        expect(limiter.hasCapacityFor(1)).toBeTrue();
        expect(limiter.hasCapacityFor(5)).toBeTrue();
        expect(limiter.hasCapacityFor(6)).toBeFalse();
    });

    it("should record usage and reduce capacity", () => {
        const limiter = new ExecutionRateLimiter(5, 1000);
        limiter.recordUsage(3);
        
        expect(limiter.hasCapacityFor(2)).toBeTrue();
        expect(limiter.hasCapacityFor(3)).toBeFalse();
    });

    it("should free up capacity after window expires", async () => {
        const limiter = new ExecutionRateLimiter(5, 100);
        limiter.recordUsage(5);
        
        expect(limiter.hasCapacityFor(1)).toBeFalse();
        
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(limiter.hasCapacityFor(5)).toBeTrue();
    });
});
