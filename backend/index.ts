import { DatabaseFactory, DatabaseFilePath, AsyncWriterFactory } from "./src/infrastructure/database/DatabaseConnection";
import { TransactionRepository } from "./src/infrastructure/database/TransactionRepository";
import { ErrorLogRepository } from "./src/infrastructure/database/ErrorLogRepository";
import { BinanceOrderExecutor } from "./src/infrastructure/BinanceOrderExecutor";
import { BinanceFeeFetcher } from "./src/infrastructure/BinanceFeeFetcher";
import { BinancePriceIngestor } from "./src/infrastructure/BinancePriceIngestor";
import { LocalStateManager } from "./src/application/LocalStateManager";
import { ArbitrageMathEngine } from "./src/application/ArbitrageMathEngine";
import { CycleEvaluator } from "./src/application/CycleEvaluator";
import { CycleExecutor } from "./src/application/CycleExecutor";
import { ArbitrageCycle } from "./src/application/ArbitrageCycle";
import { Currency } from "./src/domain/valueObjects/Currency";
import { Pair } from "./src/domain/valueObjects/Pair";
import { TriangularPairs, PairTuple } from "./src/application/TriangularPairs";
import { Amount } from "./src/domain/valueObjects/Amount";
import { BinanceBalanceFetcher } from "./src/infrastructure/BinanceBalanceFetcher";
import { VirtualBalanceManager } from "./src/infrastructure/VirtualBalanceManager";
import { SimulatedOrderExecutor } from "./src/infrastructure/SimulatedOrderExecutor";
import { TradingMode } from "./src/domain/valueObjects/TradingMode";
import { ExecutionLock } from "./src/application/ExecutionLock";
import { BinanceWsClient } from "./src/infrastructure/BinanceWsClient";
import { BinancePrecisionFetcher } from "./src/infrastructure/BinancePrecisionFetcher";


const latestErrors: string[] = [];
const originalConsoleError = console.error;
console.error = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ");
    latestErrors.push(msg);
    if (latestErrors.length > 10) latestErrors.shift();
    originalConsoleError(...args);
};

console.log("🚀 Starting HFT Triangular Arbitrage Engine...");

const envMode = process.env.TRADING_MODE === "LIVE" ? TradingMode.LIVE : TradingMode.SIMULATION;
let currentMode = envMode;

const initialSimBalanceEnv = parseFloat(process.env.SIMULATION_BALANCE || "1000");
let virtualBalanceManager = new VirtualBalanceManager(new Amount(initialSimBalanceEnv));

let bnbDiscountEnabled = process.env.BNB_DISCOUNT === "true";
let isEngineRunning = false;

const dbPath = new DatabaseFilePath("./hft.sqlite");
const db = DatabaseFactory.create(dbPath);
const asyncWriter = AsyncWriterFactory.create(db);
const transactionRepo = new TransactionRepository(asyncWriter);
const errorRepo = new ErrorLogRepository(asyncWriter);

const stateManager = new LocalStateManager();
const mathEngine = new ArbitrageMathEngine();
const ingestor = new BinancePriceIngestor();

const apiKey = process.env.BINANCE_API_KEY || "";
const apiSecret = process.env.BINANCE_API_SECRET || "";
const globalWsClient = new BinanceWsClient(apiKey, apiSecret);
globalWsClient.connect().catch(console.error);

const balanceFetcher = new BinanceBalanceFetcher(globalWsClient);
const precisionFetcher = new BinancePrecisionFetcher();
const feeFetcher = new BinanceFeeFetcher();

let currentLatency = 0;

const binanceExecutor = new BinanceOrderExecutor(globalWsClient, errorRepo, transactionRepo, precisionFetcher);
let simulatedExecutor = new SimulatedOrderExecutor(stateManager, virtualBalanceManager, transactionRepo, () => currentLatency);

const getExecutor = () => {
    return currentMode.isLive() ? binanceExecutor : simulatedExecutor;
};

const cycleEvaluator = new CycleEvaluator(stateManager, mathEngine);
const cycleExecutor = new CycleExecutor(getExecutor, errorRepo, transactionRepo);
const arbitrageCycle = new ArbitrageCycle(cycleEvaluator, cycleExecutor);

const brl = new Currency("BRL");
const eth = new Currency("ETH");
const btc = new Currency("BTC");

function createCCVTriangle(baseStr: string, quoteStr: string): TriangularPairs {
    const base = new Currency(baseStr);
    const quote = new Currency(quoteStr);
    
    const quoteBrl = new Pair(quote, brl);
    const baseQuote = new Pair(base, quote);
    const baseBrl = new Pair(base, brl);

    const tuple = new PairTuple(quoteBrl, baseQuote);
    return new TriangularPairs(tuple, baseBrl);
}

const activeTriangles: TriangularPairs[] = [
    createCCVTriangle("ETH", "BTC"),
    createCCVTriangle("PEPE", "USDT"),
    createCCVTriangle("SHIB", "USDT"),
    createCCVTriangle("DOGE", "USDT"),
];

activeTriangles.forEach(t => {
    t.apply((first, second, third) => {
        stateManager.registerPair(first);
        stateManager.registerPair(second);
        stateManager.registerPair(third);
        
        ingestor.subscribe(first);
        ingestor.subscribe(second);
        ingestor.subscribe(third);
    });
});

// Preload fees before processing ticks to avoid latency
const pairsList = [];
activeTriangles.forEach(t => t.apply((f, s, t) => pairsList.push(f, s, t)));
await feeFetcher.preloadFees(pairsList);
await precisionFetcher.preloadPrecisions();

const evaluationLock = new ExecutionLock();

ingestor.onTick(async (tick) => {
    stateManager.updateState(tick);

    await evaluationLock.runIfUnlocked(async () => {
        if (!isEngineRunning) return;
        
        try {
            let bestProfitAmount = new Amount(-9999999);
            let bestRealProfit = -9999999;

            let currentUsableBalance = 1000;
            if (currentMode.isLive()) {
                currentUsableBalance = realBalance > 0 ? realBalance : 0;
            } else {
                virtualBalanceManager.applyAllBalances((simBalances) => {
                    currentUsableBalance = simBalances.get("BRL") || 1000;
                });
            }
            // Utiliza 99% do saldo disponível para evitar erros de saldo insuficiente devido a pequenas flutuações e taxas
            const usableAmount = new Amount(currentUsableBalance * 0.99);

            for (const triangle of activeTriangles) {
                const profitAmount = await arbitrageCycle.evaluateAndExecute(
                    triangle,
                    feeFetcher,
                    mathEngine,
                    usableAmount,
                    minProfit,
                    bnbDiscountEnabled
                );

                let realProfit = 0;
                profitAmount.apply((val) => { realProfit = val; });

                if (realProfit > bestRealProfit) {
                    bestRealProfit = realProfit;
                    bestProfitAmount = profitAmount;
                    triangle.third.applyBinanceSymbol((sym) => bestTrianglePair = sym.toLowerCase());
                }
            }

            if (bestRealProfit > -999999) {
                latestPnl = bestRealProfit;
            }
        } catch (err) {
            console.error("Evaluation error:", err);
        }
    });
});

const minProfit = new Amount(0.10); // R$ 0.10 of minimum net profit

let realBalance = 0;
let realBnbBalance = 0;
let bnbDiscountLocked = false;
let bnbPriceBrl = 3000; // Valor aproximado padrão (atualizado periodicamente)
let executedVolume = 0;
let latestPnl = 0;
let bestTrianglePair = "pepebrl";

balanceFetcher.fetchBalances().then(balances => {
    balances.brl.apply((val) => { realBalance = val; });
    balances.bnb.apply((val) => { realBnbBalance = val; });
});

setInterval(async () => {
    try {
        const pingStart = Date.now();
        const balances = await balanceFetcher.fetchBalances();
        currentLatency = Date.now() - pingStart;
        
        balances.brl.apply((val) => { realBalance = val; });
        balances.bnb.apply((val) => { realBnbBalance = val; });
    } catch (err) {}
}, 5000);

console.log("✅ Initialization Complete.");
console.log("📡 Listening for market data and evaluating Arbitrage Cycles...");

let currentBasePrice = 45200.50;
let currentPnl = 1250.00;
let currentVolume = 1450200;

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
            
            if (data.type === "SET_MODE") {
                currentMode = data.mode === "LIVE" ? TradingMode.LIVE : TradingMode.SIMULATION;
                console.log(`Switched trading mode to ${data.mode}`);
            } else if (data.type === "SET_SIM_BALANCE") {
                virtualBalanceManager = new VirtualBalanceManager(new Amount(parseFloat(data.amount)));
                simulatedExecutor = new SimulatedOrderExecutor(stateManager, virtualBalanceManager, transactionRepo);
                console.log(`Reset simulation balance to ${data.amount}`);
            } else if (data.type === "SET_BNB_DISCOUNT") {
                if (data.enabled === true && bnbDiscountLocked) {
                    console.log(`⚠️ Blocked attempt to enable BNB Discount. Insufficient BNB balance.`);
                    // Força envio de status para o cliente reverter a chave visualmente
                    ws.send(JSON.stringify({
                        type: "STATUS",
                        mode: currentMode.isLive() ? "LIVE" : "SIMULATION",
                        simBalance: initialSimBalanceEnv,
                        realBalance: realBalance,
                        bnbDiscount: bnbDiscountEnabled,
                        isRunning: isEngineRunning,
                        bnbBalance: realBnbBalance,
                        bnbDiscountLocked: bnbDiscountLocked
                    }));
                    return;
                }
                const oldValue = bnbDiscountEnabled;
                bnbDiscountEnabled = data.enabled === true;
                console.log(`💰 BNB Discount: ${oldValue ? 'ON' : 'OFF'} → ${bnbDiscountEnabled ? 'ON ✅ (fees x0.75)' : 'OFF'}`);
            } else if (data.type === "TOGGLE_ENGINE") {
                isEngineRunning = data.running === true;
                console.log(`Engine running state: ${isEngineRunning ? 'ACTIVE 🟢' : 'HALTED 🔴'}`);
            } else if (data.type === "GET_STATUS") {
                let modeStr = "";
                currentMode.apply((m) => modeStr = m);
                
                virtualBalanceManager.applyAllBalances((simBalances) => {
                    const simBrl = simBalances.get("BRL") || 0;
                    ws.send(JSON.stringify({
                        type: "STATUS",
                        mode: modeStr,
                        simBalance: simBrl,
                        realBalance: realBalance,
                        bnbDiscount: bnbDiscountEnabled,
                        isRunning: isEngineRunning,
                        bnbBalance: realBnbBalance,
                        bnbDiscountLocked: bnbDiscountLocked
                    }));
                });
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

// Telemetry loop: Publishes state to frontend 4 times per second
// Atualiza o preço do BNB periodicamente
setInterval(async () => {
    try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBBRL");
        if (res.ok) {
            const data = await res.json();
            if (data.price) bnbPriceBrl = parseFloat(data.price);
        }
    } catch(e) {}
}, 60000);

setInterval(async () => {
    let modeStr = "";
    currentMode.apply((m) => modeStr = m);
    if (modeStr === "LIVE") {
        const balances = await balanceFetcher.fetchBalances();
        balances.brl.apply((val) => realBalance = val);
        balances.bnb.apply((val) => realBnbBalance = val);

        // Calcula BNB necessário (0.225% do BRL atual)
        const requiredBnbInBrl = realBalance * 0.00225;
        const requiredBnb = requiredBnbInBrl / bnbPriceBrl;

        bnbDiscountLocked = realBnbBalance < requiredBnb;
        
        if (bnbDiscountLocked && bnbDiscountEnabled) {
            bnbDiscountEnabled = false;
            console.log(`⚠️ BNB Discount automatically DISABLED! Insufficient BNB balance. Required: ${requiredBnb.toFixed(6)} BNB.`);
        }
    }
}, 2000);

setInterval(() => {
    let modeStr = "";
    currentMode.apply((m) => modeStr = m);

    let simBrl = 0;
    if (currentMode.isSimulation()) {
        virtualBalanceManager.applyAllBalances((simBalances) => {
            simBrl = simBalances.get("BRL") || 0;
        });
    }

    server.publish("dashboard", JSON.stringify({
      type: "UPDATE",
      mode: modeStr,
      pnl: latestPnl,
      simBalance: simBrl,
      realBalance: realBalance,
      latency: currentLatency,
      volume: executedVolume,
      bnbDiscount: bnbDiscountEnabled,
      bestPair: bestTrianglePair,
      isRunning: isEngineRunning,
      errors: latestErrors,
      bnbBalance: realBnbBalance,
      bnbDiscountLocked: bnbDiscountLocked
    }));
}, 50);
