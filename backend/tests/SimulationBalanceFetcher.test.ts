import { describe, expect, it } from "bun:test";
import { SimulationBalanceFetcher } from "../src/infrastructure/SimulationBalanceFetcher";
import { SimulationOrderExecutor } from "../src/infrastructure/SimulationOrderExecutor";

describe("SimulationBalanceFetcher", () => {
    it("should return balances from SimulationOrderExecutor", async () => {
        const executor = new SimulationOrderExecutor({} as any, {} as any, {} as any, {} as any);
        executor.setInitialBalances(1.5, 50000);

        const fetcher = new SimulationBalanceFetcher(executor);
        const balances = await fetcher.fetchBalances();

        let btc = 0, brl = 0;
        balances.get("BTC")?.apply(v => btc = v);
        balances.get("BRL")?.apply(v => brl = v);

        expect(btc).toBe(1.5);
        expect(brl).toBe(50000);
    });

    it("should return balances for dynamic pair", async () => {
        const executor = new SimulationOrderExecutor({} as any, {} as any, {} as any, {} as any);
        executor.setInitialBalances(10, 1000);

        const fetcher = new SimulationBalanceFetcher(executor);
        const balances = await fetcher.fetchBalancesForPair("ETH", "USDT");

        let eth = 0, usdt = 0;
        balances.get("ETH")?.apply(v => eth = v);
        balances.get("USDT")?.apply(v => usdt = v);

        expect(eth).toBe(10);
        expect(usdt).toBe(1000);
    });
});
