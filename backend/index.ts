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

console.log("🚀 Starting HFT Triangular Arbitrage Engine...");

// 1. Database Setup
const dbPath = new DatabaseFilePath("./hft.sqlite");
const db = DatabaseFactory.create(dbPath);
const asyncWriter = AsyncWriterFactory.create(db);
const transactionRepo = new TransactionRepository(asyncWriter);
const errorRepo = new ErrorLogRepository(asyncWriter);

// 2. Engine Components
const executor = new BinanceOrderExecutor(errorRepo);
const feeFetcher = new BinanceFeeFetcher();
const stateManager = new LocalStateManager();
const mathEngine = new ArbitrageMathEngine();
const ingestor = new BinancePriceIngestor();
const balanceFetcher = new BinanceBalanceFetcher();

// 3. Application Use Cases
const cycleEvaluator = new CycleEvaluator(stateManager, mathEngine);
const cycleExecutor = new CycleExecutor(executor, transactionRepo);
const arbitrageCycle = new ArbitrageCycle(cycleEvaluator, cycleExecutor);

// 4. Domain Setup
const brl = new Currency("BRL");
const btc = new Currency("BTC");
const eth = new Currency("ETH");

// Binance standard symbols: BTCBRL, ETHBTC, ETHBRL
const btcBrl = new Pair(btc, brl);
const ethBtc = new Pair(eth, btc);
const ethBrl = new Pair(eth, brl);

const pairTuple = new PairTuple(btcBrl, ethBtc);
const triangularPairs = new TriangularPairs(pairTuple, ethBrl);

stateManager.registerPair(btcBrl);
stateManager.registerPair(ethBtc);
stateManager.registerPair(ethBrl);

ingestor.subscribe(btcBrl);
ingestor.subscribe(ethBtc);
ingestor.subscribe(ethBrl);

// 4.1 Wire Ingestor to StateManager
ingestor.onTick((tick) => {
    stateManager.updateState(tick);
});

const initialAmount = new Amount(1000); // 1000 BRL
const minProfit = new Amount(1001); // Pelo menos 1 BRL de lucro

let currentBalance = 0;
let currentLatency = 0; // Medição real do Round-Trip Time
let executedVolume = 0; // Volume real negociado pelo motor

balanceFetcher.fetchBrlBalance().then(amt => {
    amt.apply((val) => { currentBalance = val; });
});

setInterval(async () => {
    try {
        const pingStart = Date.now();
        const amt = await balanceFetcher.fetchBrlBalance();
        currentLatency = Date.now() - pingStart; // Calcula o ping real até o data center da Binance
        
        amt.apply((val) => { currentBalance = val; });
    } catch (err) {}
}, 5000);

console.log("✅ Initialization Complete.");
console.log("📡 Listening for market data and evaluating Arbitrage Cycles...");

// 5. WebSocket Server for Dashboard
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
    message(ws, message) {},
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

// Simulate market loop triggering evaluateAndExecute
setInterval(async () => {
    try {
        // Math engine execution
        const profitAmount = await arbitrageCycle.evaluateAndExecute(
            triangularPairs,
            feeFetcher,
            mathEngine,
            initialAmount,
            minProfit
        );

        let realProfit = 0;
        profitAmount.apply((val) => { realProfit = val; });

        // Update Dashboard Stats
        server.publish("dashboard", JSON.stringify({
          type: "UPDATE",
          pnl: realProfit,
          balance: currentBalance,
          latency: currentLatency,
          volume: executedVolume // Será 0 até ativarmos o OrderExecutor
        }));
    } catch (err) {
        console.error("Loop error:", err);
    }
}, 250);