import { Amount } from "../domain/valueObjects/Amount";
import { SimulationOrderExecutor } from "./SimulationOrderExecutor";

/**
 * SimulationBalanceFetcher replaces BinanceBalanceFetcher in simulation mode.
 * It reads virtual balances from the SimulationOrderExecutor's internal ledger
 * and returns them in the same Map<string, Amount> format the engine expects.
 */
export class SimulationBalanceFetcher {
    constructor(private readonly simExecutor: SimulationOrderExecutor) {}

    public async fetchBalances(): Promise<Map<string, Amount>> {
        const balancesMap = new Map<string, Amount>();

        const base = this.simExecutor.baseBalance;
        const quote = this.simExecutor.quoteBalance;

        // We always return both, even if zero, so the InventoryManager
        // gets a complete picture (unlike the real fetcher which filters freeVal > 0)
        balancesMap.set("BTC", new Amount(base));
        balancesMap.set("BRL", new Amount(quote));

        return balancesMap;
    }

    /**
     * Dynamic version that accepts currency symbols at runtime,
     * so it works regardless of which pair is being traded.
     */
    public async fetchBalancesForPair(baseSymbol: string, quoteSymbol: string): Promise<Map<string, Amount>> {
        const balancesMap = new Map<string, Amount>();
        balancesMap.set(baseSymbol, new Amount(this.simExecutor.baseBalance));
        balancesMap.set(quoteSymbol, new Amount(this.simExecutor.quoteBalance));
        return balancesMap;
    }
}
