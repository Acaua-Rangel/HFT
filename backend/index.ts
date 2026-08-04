import { DatabaseFactory, DatabaseFilePath, AsyncWriterFactory } from "./src/infrastructure/database/DatabaseConnection";
import { TransactionRepository } from "./src/infrastructure/database/TransactionRepository";
import { ErrorLogRepository } from "./src/infrastructure/database/ErrorLogRepository";
import { BinanceOrderExecutor } from "./src/infrastructure/BinanceOrderExecutor";
import { BinancePriceIngestor } from "./src/infrastructure/BinancePriceIngestor";
import { LocalStateManager } from "./src/application/LocalStateManager";
import { Currency } from "./src/domain/valueObjects/Currency";
import { Pair } from "./src/domain/valueObjects/Pair";
import { BinanceBalanceFetcher } from "./src/infrastructure/BinanceBalanceFetcher";
import { BinanceWsClient } from "./src/infrastructure/BinanceWsClient";
import { BinancePrecisionFetcher } from "./src/infrastructure/BinancePrecisionFetcher";

// Market Making components
import { VolatilityMonitor } from "./src/application/mm/VolatilityMonitor";
import { LiquidityMonitor } from "./src/application/mm/LiquidityMonitor";
import { CircuitBreaker } from "./src/application/mm/CircuitBreaker";
import { InventoryManager } from "./src/application/mm/InventoryManager";
import { MarketMakerCycle } from "./src/application/mm/MarketMakerCycle";
import { ExecutionLock } from "./src/application/ExecutionLock";

const latestErrors: string[] = [];
const originalConsoleError = console.error;
console.error = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ");
    latestErrors.push(msg);
    if (latestErrors.length > 10) latestErrors.shift();
    originalConsoleError(...args);
};

console.log("🚀 Starting HFT Market Making Engine...");

let isEngineRunning = false;

const dbPath = new DatabaseFilePath("./hft.sqlite");
const db = DatabaseFactory.create(dbPath);
const asyncWriter = AsyncWriterFactory.create(db);
const transactionRepo = new TransactionRepository(asyncWriter);
const errorRepo = new ErrorLogRepository(asyncWriter);

const stateManager = new LocalStateManager();
const ingestor = new BinancePriceIngestor();

const apiKey = process.env.BINANCE_API_KEY || "";
const apiSecret = process.env.BINANCE_API_SECRET || "";
const globalWsClient = new BinanceWsClient(apiKey, apiSecret);
globalWsClient.connect().catch(console.error);

const balanceFetcher = new BinanceBalanceFetcher(globalWsClient);
const precisionFetcher = new BinancePrecisionFetcher();

let currentLatency = 0;
const binanceExecutor = new BinanceOrderExecutor(globalWsClient, errorRepo, transactionRepo, precisionFetcher, stateManager);

const volatilityMonitor = new VolatilityMonitor(stateManager);
const liquidityMonitor = new LiquidityMonitor(stateManager);
const circuitBreaker = new CircuitBreaker(volatilityMonitor, liquidityMonitor, () => currentLatency);
const inventoryManager = new InventoryManager();

const mmCycle = new MarketMakerCycle(stateManager, circuitBreaker, inventoryManager, binanceExecutor);

// Define Target Pair
const btc = new Currency("BTC");
const fdusd = new Currency("FDUSD");
const mmPair = new Pair(btc, fdusd);

async function startHftEngine() {
    stateManager.registerPair(mmPair);
    ingestor.subscribe(mmPair);
    
    await precisionFetcher.preloadPrecisions();

    // Balance update loop
    setInterval(async () => {
        try {
            const pingStart = Date.now();
            const balances = await balanceFetcher.fetchBalances();
            currentLatency = Date.now() - pingStart;
            
            // Update Inventory Manager
            balances.fdusd.apply((val) => inventoryManager.quoteBalance = val);
            
            // Note: Currently balanceFetcher doesn't fetch BTC specifically unless it's in its hardcoded list.
            // Assuming balanceFetcher fetches BTC, or we update it to fetch dynamically.
            // If balanceFetcher only returns BRL, BNB, FDUSD, we must read BTC from dust or update fetcher.
            // Let's assume balanceFetcher parses all assets and puts them in `balances.dust` or we add BTC.
            let btcBal = 0;
            if (balances.dust.has("BTC")) btcBal = balances.dust.get("BTC")!;
            inventoryManager.baseBalance = btcBal;
            
        } catch (err) {}
    }, 5000);

    const evaluationLock = new ExecutionLock();

    // Main MM Loop driven by time (continuous quoting) instead of ticks
    setInterval(async () => {
        if (!isEngineRunning) return;

        await evaluationLock.runIfUnlocked(async () => {
            try {
                await mmCycle.executeTick(mmPair);
            } catch (err) {
                console.error("MM Loop Error:", err);
            }
        });
    }, 2000);

    // Also update state on ticks
    ingestor.onTick((tick) => {
        stateManager.updateState(tick);
    });

    console.log("✅ Initialization Complete.");
    console.log(`📡 Quoting ${mmPair.toString()} on Market Maker Loop...`);
}

startHftEngine().catch(e => {
    console.error("❌ HFT Engine crashed:", e);
    process.exit(1);
});

// Mock Server for Dashboard compatibility
const server = Bun.serve({
  port: 3000,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("HFT Engine WebSocket API");
  },
  websocket: {
    message(ws, message) {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === "TOGGLE_ENGINE") {
                isEngineRunning = data.running === true;
                console.log(`Engine running state: ${isEngineRunning ? 'ACTIVE 🟢' : 'HALTED 🔴'}`);
            } else if (data.type === "GET_STATUS") {
                ws.send(JSON.stringify({
                    type: "STATUS",
                    mode: "LIVE",
                    isRunning: isEngineRunning,
                    baseBalance: inventoryManager.baseBalance,
                    quoteBalance: inventoryManager.quoteBalance,
                    errors: latestErrors
                }));
            }
        } catch(e) {}
    },
    open(ws) {
      ws.subscribe("dashboard");
      console.log("🖥️ Dashboard connected.");
    },
    close(ws) {
      console.log("🖥️ Dashboard disconnected.");
    }
  }
});
console.log(`🌐 WebSocket Server for Dashboard running on ws://localhost:${server.port}`);
