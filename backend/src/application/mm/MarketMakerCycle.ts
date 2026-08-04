import { Pair } from "../../domain/valueObjects/Pair";
import { OrderExecutor } from "../../domain/interfaces/OrderExecutor";
import { Amount } from "../../domain/valueObjects/Amount";
import { LocalStateManager } from "../LocalStateManager";
import { CircuitBreaker } from "./CircuitBreaker";
import { InventoryManager } from "./InventoryManager";

export class MarketMakerCycle {
    // 50 FDUSD worth of BTC per lot (adjustable)
    private readonly LOT_SIZE_QUOTE = 50; 

    constructor(
        private stateManager: LocalStateManager,
        private circuitBreaker: CircuitBreaker,
        private inventoryManager: InventoryManager,
        private executor: OrderExecutor
    ) {}

    public async executeTick(pair: Pair): Promise<void> {
        if (this.circuitBreaker.shouldPause(pair)) {
            return; // Paused by risk
        }

        const book = this.stateManager.retrieveOrderBook(pair);
        if (!book) return;
        const tick = book.getLatest();
        if (!tick) return;

        const midPriceAmount = tick.getMidPrice();
        if (!midPriceAmount) return;

        let midPrice = 0;
        midPriceAmount.apply(v => midPrice = v);
        if (midPrice <= 0) return;

        const { bid, ask, bidEnabled, askEnabled } = this.inventoryManager.getQuotes(midPrice);

        // Convert LOT_SIZE_QUOTE ($50) to Base Asset (BTC)
        const baseAmountRaw = this.LOT_SIZE_QUOTE / midPrice;
        
        // We will execute both simultaneously if enabled.
        // executeMakerBuy/Sell will block for TTL (e.g. 2.5s) and cancel automatically.
        const promises: Promise<any>[] = [];

        if (bidEnabled && bid > 0) {
            // We want to buy LOT_SIZE_QUOTE worth of Base
            const quoteToSpend = new Amount(this.LOT_SIZE_QUOTE); 
            // executeMakerBuy expects amount in QUOTE (BRL/USDT/FDUSD) to spend
            promises.push(this.executor.executeMakerBuy(pair, quoteToSpend, new Amount(bid)));
        }

        if (askEnabled && ask > 0) {
            // We want to sell baseAmountRaw of Base
            const baseToSell = new Amount(baseAmountRaw);
            promises.push(this.executor.executeMakerSell(pair, baseToSell, new Amount(ask)));
        }

        if (promises.length > 0) {
            await Promise.all(promises);
            // After TTL, both will return their fills (which are logged internally).
            // The index.ts loop can then run the next tick.
        }
    }
}
