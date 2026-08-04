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
import { SimulationOrderExecutor } from "./src/infrastructure/SimulationOrderExecutor";
import { SimulationBalanceFetcher } from "./src/infrastructure/SimulationBalanceFetcher";

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
let currentMode: "LIVE" | "SIMULATION" = "SIMULATION"; // Default to SIMULATION for safety

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
const simExecutor = new SimulationOrderExecutor(errorRepo, transactionRepo, precisionFetcher, stateManager);
const simBalanceFetcher = new SimulationBalanceFetcher(simExecutor);

const volatilityMonitor = new VolatilityMonitor(stateManager);
const liquidityMonitor = new LiquidityMonitor(stateManager);
let globalBnbBalance = 0;
let isBnbDiscountLocked = false;
const circuitBreaker = new CircuitBreaker(volatilityMonitor, liquidityMonitor, () => currentLatency);
const inventoryManager = new InventoryManager();

// Start in SIMULATION mode by default
const mmCycle = new MarketMakerCycle(stateManager, circuitBreaker, inventoryManager, simExecutor);

// Define Target Pair
const btc = new Currency("BTC");
const brl = new Currency("BRL");
const mmPair = new Pair(btc, brl);

// --- Mode Switching Logic ---
function switchMode(newMode: "LIVE" | "SIMULATION", simQuoteBalance?: number) {
    if (newMode === currentMode) return;

    isEngineRunning = false; // Halt engine during switch
    currentMode = newMode;

    if (newMode === "SIMULATION") {
        const initialQuote = simQuoteBalance ?? 1000;
        simExecutor.setInitialBalances(0, initialQuote);
        mmCycle.executor = simExecutor;
        console.log(`🧪 Switched to SIMULATION mode (Quote: ${initialQuote})`);
    } else {
        mmCycle.executor = binanceExecutor;
        console.log(`⚡ Switched to LIVE mode`);
    }
}

async function startHftEngine() {
    stateManager.registerPair(mmPair);
    ingestor.subscribe(mmPair);
    
    await precisionFetcher.preloadPrecisions();

    let quoteSym = "";
    mmPair.applyCurrencies((b, q) => q.applySymbol(s => quoteSym = s.toUpperCase()));
    const bnbPair = new Pair(new Currency("BNB"), new Currency(quoteSym));
    if (quoteSym !== "BNB") {
        stateManager.registerPair(bnbPair);
        ingestor.subscribe(bnbPair);
    }

    // Initialize simulation with a default balance
    simExecutor.setInitialBalances(0, 1000, 1.0); // 1.0 BNB by default to test lock

    // Balance update loop — reads from the appropriate source based on mode
    // Dedicated latency monitor (real ping to Binance API)
    setInterval(async () => {
        try {
            if (globalWsClient.isReady()) {
                currentLatency = await globalWsClient.ping();
            } else {
                const start = Date.now();
                await fetch("https://api.binance.com/api/v3/ping");
                currentLatency = Date.now() - start;
            }
        } catch (err) {
            // Ignore temporary network errors
        }
    }, 5000);

    // Balance update loop (every 5s)
    setInterval(async () => {
        try {
            let baseBal = 0;
            let quoteBal = 0;

            if (currentMode === "LIVE") {
                const balances = await balanceFetcher.fetchBalances();
                
                mmPair.applyCurrencies((base, quote) => {
                    base.applySymbol((baseSym) => {
                        const baseAmount = balances.get(baseSym);
                        if (baseAmount) baseAmount.apply(val => baseBal = val);
                    });
                    quote.applySymbol((quoteSym) => {
                        const quoteAmount = balances.get(quoteSym);
                        if (quoteAmount) quoteAmount.apply(val => quoteBal = val);
                    });
                });
                const bnbAmount = balances.get("BNB");
                if (bnbAmount) bnbAmount.apply(val => globalBnbBalance = val);
            } else {
                // SIMULATION: read virtual balances from SimulationOrderExecutor
                baseBal = simExecutor.baseBalance;
                quoteBal = simExecutor.quoteBalance;
                globalBnbBalance = simExecutor.bnbBalance;
            }
            
            inventoryManager.baseBalance = baseBal;
            inventoryManager.quoteBalance = quoteBal;
            
        } catch (err) {}
    }, 5000);

    const evaluationLock = new ExecutionLock();

    // Main MM Loop driven by time (continuous quoting) instead of ticks
    setInterval(async () => {
        if (!isEngineRunning) return;

        await evaluationLock.runIfUnlocked(async () => {
            try {
                let quoteSym = "";
                mmPair.applyCurrencies((b, q) => { q.applySymbol(s => quoteSym = s.toUpperCase()); });
                
                // BNB Fee Protection Calculation
                if (quoteSym !== "BNB") {
                    let bnbQuotePrice = 0;
                    const bnbPairObj = new Pair(new Currency("BNB"), new Currency(quoteSym));
                    const bnbBook = stateManager.retrieveOrderBook(bnbPairObj);
                    if (bnbBook) {
                        const bnbTick = bnbBook.getLatest();
                        if (bnbTick) bnbTick.getMidPrice()?.apply(v => bnbQuotePrice = v);
                    }

                    if (bnbQuotePrice > 0) {
                        const baseLotQuote = mmCycle.lotConfig.mode === "PERCENTAGE" 
                            ? inventoryManager.quoteBalance * mmCycle.lotConfig.value 
                            : mmCycle.lotConfig.value;
                        // Estimate fee for 1 Buy and 1 Sell
                        const estimatedQuoteFee = (baseLotQuote * 2) * 0.00075; 
                        const bnbRequired = estimatedQuoteFee / bnbQuotePrice;
                        
                        if (bnbRequired > globalBnbBalance) {
                            if (!isBnbDiscountLocked) {
                                console.log(`🔒 BNB Fee Lock Triggered! Req: ${bnbRequired.toFixed(5)} BNB | Bal: ${globalBnbBalance.toFixed(5)} BNB | Lot: ${baseLotQuote.toFixed(2)} | BnbPx: ${bnbQuotePrice.toFixed(2)}`);
                            }
                            simExecutor.bnbDiscountEnabled = false;
                            isBnbDiscountLocked = true;
                        } else {
                            if (isBnbDiscountLocked) {
                                console.log(`🔓 BNB Fee Lock Released. Req: ${bnbRequired.toFixed(5)} BNB | Bal: ${globalBnbBalance.toFixed(5)} BNB`);
                            }
                            isBnbDiscountLocked = false;
                        }
                    }
                }
                
                const bnbEnabled = currentMode === "LIVE" ? !isBnbDiscountLocked : simExecutor.bnbDiscountEnabled;
                const feeRate = quoteSym === "FDUSD" ? 0 : (bnbEnabled ? 0.00075 : 0.001);
                const volatilityPct = volatilityMonitor.getVolatilityPercentage(mmPair);

                await mmCycle.executeTick(mmPair, feeRate, volatilityPct);
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
    console.log(`🧪 Starting in SIMULATION mode (safe default)`);
}

startHftEngine().catch(e => {
    console.error("❌ HFT Engine crashed:", e);
    process.exit(1);
});

// WebSocket Server for Dashboard
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
            } else if (data.type === "TOGGLE_MODE") {
                const newMode = data.mode === "LIVE" ? "LIVE" : "SIMULATION";
                switchMode(newMode, data.simBalance);
                // Broadcast updated status to all clients
                server.publish("dashboard", JSON.stringify({
                    type: "STATUS",
                    mode: currentMode,
                    isRunning: isEngineRunning,
                    baseBalance: inventoryManager.baseBalance,
                    quoteBalance: inventoryManager.quoteBalance,
                    gamma: inventoryManager.GAMMA,
                    baseSpreadPct: inventoryManager.BASE_SPREAD_PCT,
                    maxInventorySkew: inventoryManager.MAX_INVENTORY_SKEW,
                    errors: latestErrors,
                    lotMode: mmCycle.lotConfig.mode,
                    lotValue: mmCycle.lotConfig.value,
                    bnbDiscountLocked: isBnbDiscountLocked,
                    bnbBalance: globalBnbBalance
                }));
            } else if (data.type === "SET_SIM_BALANCE") {
                if (currentMode === "SIMULATION" && data.quoteBalance !== undefined) {
                    simExecutor.setInitialBalances(simExecutor.baseBalance, data.quoteBalance, simExecutor.bnbBalance);
                    inventoryManager.quoteBalance = data.quoteBalance;
                    console.log(`🧪 [SIM] Quote balance updated to: ${data.quoteBalance}`);
                }
            } else if (data.type === "SET_SIM_BNB_BALANCE") {
                if (currentMode === "SIMULATION" && data.bnbBalance !== undefined) {
                    simExecutor.setBnbBalance(data.bnbBalance);
                    globalBnbBalance = data.bnbBalance;
                    console.log(`🧪 [SIM] BNB balance updated to: ${data.bnbBalance}`);
                }
            } else if (data.type === "GET_STATUS") {
                ws.send(JSON.stringify({
                    type: "STATUS",
                    mode: currentMode,
                    isRunning: isEngineRunning,
                    baseBalance: inventoryManager.baseBalance,
                    quoteBalance: inventoryManager.quoteBalance,
                    gamma: inventoryManager.GAMMA,
                    baseSpreadPct: inventoryManager.BASE_SPREAD_PCT,
                    maxInventorySkew: inventoryManager.MAX_INVENTORY_SKEW,
                    errors: latestErrors,
                    lotMode: mmCycle.lotConfig.mode,
                    lotValue: mmCycle.lotConfig.value,
                    bnbDiscountLocked: isBnbDiscountLocked,
                    bnbBalance: globalBnbBalance
                }));
            } else if (data.type === "UPDATE_MM_PARAMS") {
                if (data.gamma !== undefined) inventoryManager.GAMMA = data.gamma;
                if (data.baseSpreadPct !== undefined) inventoryManager.BASE_SPREAD_PCT = data.baseSpreadPct;
                if (data.maxInventorySkew !== undefined) inventoryManager.MAX_INVENTORY_SKEW = data.maxInventorySkew;
                console.log(`🔧 Updated MM Params: Gamma=${inventoryManager.GAMMA}, Spread=${inventoryManager.BASE_SPREAD_PCT}, MaxSkew=${inventoryManager.MAX_INVENTORY_SKEW}`);
            } else if (data.type === "UPDATE_LOT_CONFIG") {
                if (data.mode !== undefined) mmCycle.lotConfig.mode = data.mode;
                if (data.value !== undefined) mmCycle.lotConfig.value = data.value;
                console.log(`🔧 Updated Lot Config: Mode=${mmCycle.lotConfig.mode}, Value=${mmCycle.lotConfig.value}`);
            } else if (data.type === "SET_BNB_DISCOUNT") {
                if (!isBnbDiscountLocked) {
                    simExecutor.bnbDiscountEnabled = data.enabled === true;
                    console.log(`🧪 [SIM] BNB Discount: ${simExecutor.bnbDiscountEnabled ? 'ON (-25% fee)' : 'OFF (standard fee)'}`);
                }
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

// Telemetry Broadcast Loop
setInterval(() => {
    const book = stateManager.retrieveOrderBook(mmPair);
    if (!book) return;
    const tick = book.getLatest();
    if (!tick) return;
    const midPriceAmount = tick.getMidPrice();
    if (!midPriceAmount) return;
    let midPrice = 0;
    midPriceAmount.apply(v => midPrice = v);
    if (midPrice <= 0) return;

    let baseSym = ""; let quoteSym = "";
    mmPair.applyCurrencies((b, q) => { b.applySymbol(s => baseSym = s); q.applySymbol(s => quoteSym = s); });

    const bnbEnabled = simExecutor.bnbDiscountEnabled;
    const feeRate = quoteSym === "FDUSD" ? 0 : (bnbEnabled ? 0.00075 : 0.001);
    const volatilityPct = volatilityMonitor.getVolatilityPercentage(mmPair);

    const quotes = inventoryManager.getQuotes(midPrice, feeRate, volatilityPct);

    let bnbPrice = 0;
    if (quoteSym !== "BNB") {
        const bnbPairObj = new Pair(new Currency("BNB"), new Currency(quoteSym));
        const bnbBook = stateManager.retrieveOrderBook(bnbPairObj);
        if (bnbBook) {
            const bnbTick = bnbBook.getLatest();
            if (bnbTick) bnbTick.getMidPrice()?.apply(v => bnbPrice = v);
        }
    } else {
        bnbPrice = 1.0;
    }

    server.publish("dashboard", JSON.stringify({
        type: "TELEMETRY",
        mode: currentMode,
        midPrice,
        bid: quotes.bid,
        ask: quotes.ask,
        q: quotes.q,
        reservationPrice: quotes.reservationPrice,
        baseBalance: inventoryManager.baseBalance,
        quoteBalance: inventoryManager.quoteBalance,
        bnbBalance: globalBnbBalance,
        bnbPrice: bnbPrice,
        baseSymbol: baseSym,
        quoteSymbol: quoteSym,
        gamma: inventoryManager.GAMMA,
        baseSpreadPct: inventoryManager.BASE_SPREAD_PCT,
        maxInventorySkew: inventoryManager.MAX_INVENTORY_SKEW,
        latency: currentLatency,
        bnbDiscount: simExecutor.bnbDiscountEnabled,
        totalFees: simExecutor.totalFeesCollected,
        effectiveSpread: quotes.effectiveSpread,
        minSpreadFloor: quotes.minSpreadFloor,
        volatilityPct: volatilityPct,
        lotMode: mmCycle.lotConfig.mode,
        lotValue: mmCycle.lotConfig.value,
        effectiveBuyLot: mmCycle.currentEffectiveBuyLotQuote,
        effectiveSellLot: mmCycle.currentEffectiveSellLotQuote
    }));
}, 1000);

console.log(`🌐 WebSocket Server for Dashboard running on ws://localhost:${server.port}`);
