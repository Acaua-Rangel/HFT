import { test, expect, describe } from "bun:test";
import { ExecutionLock } from "../src/application/ExecutionLock";

describe("ExecutionLock", () => {
    test("should acquire and release lock correctly", () => {
        const lock = new ExecutionLock();
        
        expect(lock.isCurrentlyLocked()).toBe(false);
        
        const acquired = lock.acquire();
        expect(acquired).toBe(true);
        expect(lock.isCurrentlyLocked()).toBe(true);
        
        const acquiredAgain = lock.acquire();
        expect(acquiredAgain).toBe(false); // Should not acquire if already locked
        expect(lock.isCurrentlyLocked()).toBe(true);

        lock.release();
        expect(lock.isCurrentlyLocked()).toBe(false);

        const acquiredAfterRelease = lock.acquire();
        expect(acquiredAfterRelease).toBe(true);
    });

    test("runIfUnlocked should prevent concurrent executions", async () => {
        const lock = new ExecutionLock();
        let executionCount = 0;

        const slowTask = async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
            executionCount++;
        };

        // Try to execute the task concurrently 3 times
        const p1 = lock.runIfUnlocked(slowTask);
        const p2 = lock.runIfUnlocked(slowTask);
        const p3 = lock.runIfUnlocked(slowTask);

        await Promise.all([p1, p2, p3]);

        // Since the lock prevents concurrent execution, only the first call should succeed
        expect(executionCount).toBe(1);
    });

    test("runIfUnlocked should release the lock even if an error is thrown", async () => {
        const lock = new ExecutionLock();

        const failingTask = async () => {
            throw new Error("Simulated failure");
        };

        // Suppress the error for this test
        try {
            await lock.runIfUnlocked(failingTask);
        } catch (e) {
            // expected
        }

        // Lock should be released despite the error
        expect(lock.isCurrentlyLocked()).toBe(false);
        
        // We should be able to acquire it again
        const acquired = lock.acquire();
        expect(acquired).toBe(true);
    });
});
