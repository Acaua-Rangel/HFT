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
import { TimeProvider } from "./src/infrastructure/TimeProvider";
import { BinanceHistoricalDownloader } from "./src/infrastructure/BinanceHistoricalDownloader";
import { HistoricalPriceIngestor } from "./src/infrastructure/HistoricalPriceIngestor";
// Market Making components
import { VolatilityMonitor } from "./src/application/mm/VolatilityMonitor";
import { TrendMonitor } from "./src/application/mm/TrendMonitor";
import { LiquidityMonitor } from "./src/application/mm/LiquidityMonitor";
import { CircuitBreaker } from "./src/application/mm/CircuitBreaker";
import { InventoryManager } from "./src/application/mm/InventoryManager";
import { MarketMakerCycle } from "./src/application/mm/MarketMakerCycle";
import { ExecutionLock } from "./src/application/ExecutionLock";
import { BinanceUserDataStream } from "./src/infrastructure/BinanceUserDataStream";
import { TradeIntensityMonitor } from "./src/application/mm/TradeIntensityMonitor";
import { RiskManager } from "./src/application/mm/RiskManager";
import { BinanceFeeFetcher } from "./src/infrastructure/BinanceFeeFetcher";

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
let currentMode: "LIVE" | "BACKTEST" = "BACKTEST"; // Default to BACKTEST for safety

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
// Verdadeiro enquanto o laço do backtest está iterando. Esse laço é síncrono e só cede o
// event loop a cada 1000 ticks, então qualquer medição de latência feita durante ele mede
// starvation, não rede.
let isBacktestRunning = false;
const binanceExecutor = new BinanceOrderExecutor(globalWsClient, errorRepo, transactionRepo, precisionFetcher, stateManager);
const simExecutor = new SimulationOrderExecutor(errorRepo, transactionRepo, precisionFetcher, stateManager);
const simBalanceFetcher = new SimulationBalanceFetcher(simExecutor);

const volatilityMonitor = new VolatilityMonitor(stateManager);
const trendMonitor = new TrendMonitor(stateManager);
const liquidityMonitor = new LiquidityMonitor(stateManager);

// A trava de latência só se aplica quando há ordem real viajando até a exchange. Em
// BACKTEST não há, e a medida ainda por cima fica inflada pelo laço síncrono do backtest.
const circuitBreaker = new CircuitBreaker(
    volatilityMonitor,
    liquidityMonitor,
    () => (currentMode === "LIVE" && !isBacktestRunning) ? currentLatency : null
);
const inventoryManager = new InventoryManager();

const tradeIntensityMonitor = new TradeIntensityMonitor(ingestor);
const riskManager = new RiskManager();

const userDataStream = new BinanceUserDataStream(globalWsClient);
// Bind userDataStream to simulation executor
simExecutor.setUserDataStream(userDataStream);

// Only connect UserDataStream if running in LIVE mode (starts disconnected in SIMULATION)

// Start in SIMULATION mode by default
const mmCycle = new MarketMakerCycle(stateManager, circuitBreaker, inventoryManager, simExecutor, userDataStream);

// Define Target Pair
const btc = new Currency("BTC");
const fdusd = new Currency("FDUSD");
const mmPair = new Pair(btc, fdusd);

// --- Taxa maker efetiva ---
// Lida da exchange, não de uma lista hardcoded. A versão anterior assumia promo de taxa
// zero para pares FDUSD a partir de uma lista fixa de bases; se a Binance encerrar a promo,
// o piso de spread (2 × feeRate × 1.5) vira zero e o bot passa a cotar abaixo do custo de
// round-trip sem nenhum sinal. Aqui a taxa é consultada e revalidada periodicamente.
const feeFetcher = new BinanceFeeFetcher();
let currentMakerFee = 0.001; // default conservador até a primeira leitura

async function refreshMakerFee(): Promise<void> {
    try {
        await feeFetcher.preloadFees([mmPair]);
        let fetched = currentMakerFee;
        feeFetcher.getFeeFor(mmPair).percentage.apply(v => fetched = v);

        if (fetched !== currentMakerFee) {
            console.log(`💰 Taxa maker atualizada: ${(currentMakerFee * 100).toFixed(4)}% → ${(fetched * 100).toFixed(4)}%`);
            if (fetched > currentMakerFee) {
                console.warn(`⚠️ A taxa SUBIU. O piso de spread agora exige ${(fetched * 2 * 1.5 * 100).toFixed(4)}% para cobrir o round-trip.`);
            }
            currentMakerFee = fetched;
        }
    } catch (err) {
        console.warn("⚠️ Falha ao ler a taxa maker; mantendo o último valor conhecido.", err);
    }
}

// --- Mode Switching Logic ---
function switchMode(newMode: "LIVE" | "BACKTEST", simQuoteBalance?: number) {
    if (newMode === currentMode) return;

    isEngineRunning = false; // Halt engine during switch
    currentMode = newMode;

    if (newMode === "BACKTEST") {
        const initialQuote = simQuoteBalance ?? 1000;
        simExecutor.setInitialBalances(0, initialQuote);
        mmCycle.executor = simExecutor;
        userDataStream.disconnect();
        
        // Clear simulation orderbook
        simExecutor.cancelAllOrders(mmPair).catch(console.error);
        console.log(`🧪 Switched to BACKTEST mode (Quote: ${initialQuote})`);
    } else if (newMode === "LIVE") {
        mmCycle.executor = binanceExecutor;
        userDataStream.connect().catch(console.error);
        
        // Cancel all existing orders for the pair to start with a clean slate
        binanceExecutor.cancelAllOrders(mmPair).catch(console.error);
        
        console.log(`⚡ Switched to LIVE mode`);
    }
}

async function startHftEngine() {
    stateManager.registerPair(mmPair);
    ingestor.subscribe(mmPair);
    
    await precisionFetcher.preloadPrecisions();

    // Taxa real antes de qualquer cotação, e revalidação de hora em hora.
    await refreshMakerFee();
    console.log(`💰 Taxa maker efetiva: ${(currentMakerFee * 100).toFixed(4)}% (round-trip: ${(currentMakerFee * 2 * 100).toFixed(4)}%)`);
    setInterval(() => { refreshMakerFee().catch(() => {}); }, 3600000);



    // Initialize simulation with a default balance
    simExecutor.setInitialBalances(0, 1000);

    // Balance update loop — reads from the appropriate source based on mode
    // Dedicated latency monitor (real ping to Binance API)
    setInterval(async () => {
        // Medir durante o backtest só produziria lixo: o laço bloqueia o event loop entre
        // os yields, então o tempo observado do ping é starvation somada à rede.
        if (isBacktestRunning) return;
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

            } else {
                // SIMULATION: read virtual balances from SimulationOrderExecutor
                baseBal = simExecutor.baseBalance;
                quoteBal = simExecutor.quoteBalance;

            }
            
            inventoryManager.baseBalance = baseBal;
            inventoryManager.quoteBalance = quoteBal;
            
        } catch (err) {}
    }, 5000);

    const evaluationLock = new ExecutionLock();

    // Main MM Loop driven by time (continuous quoting) instead of ticks
    async function runMarketMakerLoop() {
        if (!isEngineRunning) {
            setTimeout(runMarketMakerLoop, 2000);
            return;
        }

        await evaluationLock.runIfUnlocked(async () => {
            try {
                const feeRate = currentMakerFee;
                const isZeroFeePromo = feeRate === 0;

                // Amostra a volatilidade uma única vez por ciclo. O getter é puro; quem
                // coleta é o record(). Antes o getter mutava o histórico e era chamado
                // 2–3× por ciclo, então a estimativa dependia da contagem de chamadas.
                volatilityMonitor.record(mmPair);
                const volatilityPct = volatilityMonitor.getVolatilityPercentage(mmPair);

                // Mesmo contrato do VolatilityMonitor: coleta uma vez por ciclo, getter puro.
                trendMonitor.record(mmPair);
                const trendSignal = trendMonitor.getTrendSignal(mmPair);

                // Fetch current midPrice
                let midPrice = 0;
                const book = stateManager.retrieveOrderBook(mmPair);
                if (book) {
                    const tick = book.getLatest();
                    if (tick) {
                        tick.getMidPrice()?.apply(v => midPrice = v);
                    }
                }
                
                let loopSymbol = "";
                mmPair.applyBinanceSymbol(s => loopSymbol = s);
                const minNotional = precisionFetcher.getMinNotional(loopSymbol);

                // --- Risk Manager (Kill Switch) ---
                const totalWealth = (inventoryManager.baseBalance * midPrice) + inventoryManager.quoteBalance;
                if (riskManager.checkGlobalStopLoss(totalWealth)) {
                    isEngineRunning = false;
                    console.error("🛑 ENGINE HALTED BY GLOBAL STOP LOSS.");

                    // Liquidar ANTES de parar. A versão anterior apenas cancelava as ordens
                    // e desligava o motor, deixando o estoque de BTC exposto e sem ninguém
                    // gerindo — o "stop loss" congelava a perda em vez de realizá-la, e a
                    // posição seguia andando com o mercado até intervenção manual.
                    //
                    // O alvo aqui é ZERO, não o INVENTORY_TARGET_BASE_PCT: se o motor vai
                    // desligar, o estado seguro é 100% em stablecoin. Manter 25% de BTC
                    // "no alvo" só faz sentido enquanto alguém está cotando em torno dele.
                    await mmCycle.flattenInventory(mmPair, midPrice, minNotional, 0);
                    await mmCycle.cancelAllActiveOrders();
                    return;
                }

                const currentK = tradeIntensityMonitor.getK(mmPair);

                await mmCycle.executeTick(
                    mmPair, feeRate, volatilityPct, isZeroFeePromo, currentK, minNotional,
                    trendSignal, trendMonitor.TREND_THRESHOLD, trendMonitor.TREND_FLATTEN_THRESHOLD
                );
            } catch (err) {
                console.error("MM Loop Error:", err);
            }
        });

        setTimeout(runMarketMakerLoop, 2000);
    }
    
    runMarketMakerLoop();

    // Also update state on ticks
    ingestor.onTick((tick) => {
        stateManager.updateState(tick);
    });

    console.log("✅ Initialization Complete.");
    console.log(`📡 Quoting ${mmPair.toString()} on Market Maker Loop...`);
    console.log(`🧪 Starting in BACKTEST mode (safe default)`);
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
            } else if (data.type === "RUN_BACKTEST") {
                executeBacktest(data.startTime, data.endTime, data.initialBalance).catch(console.error);
            } else if (data.type === "TOGGLE_MODE") {
                const newMode = data.mode === "LIVE" ? "LIVE" : "BACKTEST";
                switchMode(newMode, data.simBalance);
                // Broadcast updated status to all clients
                server.publish("dashboard", JSON.stringify({
                    type: "STATUS",
                    mode: currentMode,
                    isRunning: isEngineRunning,
                    baseBalance: inventoryManager.baseBalance,
                    quoteBalance: inventoryManager.quoteBalance,
                    gamma: inventoryManager.GAMMA,
                    safetyMultiplier: inventoryManager.SAFETY_MULTIPLIER,
                    baseSpreadPct: inventoryManager.BASE_SPREAD_PCT,
                    maxInventorySkew: inventoryManager.MAX_INVENTORY_SKEW,
                    inventoryTargetBasePct: inventoryManager.INVENTORY_TARGET_BASE_PCT,
                    trendThreshold: trendMonitor.TREND_THRESHOLD,
                    trendFlattenThreshold: trendMonitor.TREND_FLATTEN_THRESHOLD,
                    trendFlattenEnabled: mmCycle.TREND_FLATTEN_ENABLED,
                    errors: latestErrors,
                    lotMode: mmCycle.lotConfig.mode,
                    lotValue: mmCycle.lotConfig.value
                }));
            } else if (data.type === "SET_SIM_BALANCE") {
                if (currentMode === "BACKTEST" && data.quoteBalance !== undefined) {
                    simExecutor.setInitialBalances(simExecutor.baseBalance, data.quoteBalance);
                    inventoryManager.quoteBalance = data.quoteBalance;
                    console.log(`🧪 [SIM] Quote balance updated to: ${data.quoteBalance}`);
                }
            } else if (data.type === "GET_STATUS") {
                ws.send(JSON.stringify({
                    type: "STATUS",
                    mode: currentMode,
                    isRunning: isEngineRunning,
                    baseBalance: inventoryManager.baseBalance,
                    quoteBalance: inventoryManager.quoteBalance,
                    gamma: inventoryManager.GAMMA,
                    safetyMultiplier: inventoryManager.SAFETY_MULTIPLIER,
                    baseSpreadPct: inventoryManager.BASE_SPREAD_PCT,
                    maxInventorySkew: inventoryManager.MAX_INVENTORY_SKEW,
                    inventoryTargetBasePct: inventoryManager.INVENTORY_TARGET_BASE_PCT,
                    trendThreshold: trendMonitor.TREND_THRESHOLD,
                    trendFlattenThreshold: trendMonitor.TREND_FLATTEN_THRESHOLD,
                    trendFlattenEnabled: mmCycle.TREND_FLATTEN_ENABLED,
                    errors: latestErrors,
                    lotMode: mmCycle.lotConfig.mode,
                    lotValue: mmCycle.lotConfig.value
                }));
            } else if (data.type === "UPDATE_MM_PARAMS") {
                if (data.gamma !== undefined) inventoryManager.GAMMA = data.gamma;
                if (data.safetyMultiplier !== undefined) inventoryManager.SAFETY_MULTIPLIER = data.safetyMultiplier;
                if (data.baseSpreadPct !== undefined) inventoryManager.BASE_SPREAD_PCT = data.baseSpreadPct;
                if (data.maxInventorySkew !== undefined) inventoryManager.MAX_INVENTORY_SKEW = data.maxInventorySkew;
                if (data.inventoryTargetBasePct !== undefined) inventoryManager.INVENTORY_TARGET_BASE_PCT = data.inventoryTargetBasePct;
                if (data.trendThreshold !== undefined) trendMonitor.TREND_THRESHOLD = data.trendThreshold;
                if (data.trendFlattenThreshold !== undefined) trendMonitor.TREND_FLATTEN_THRESHOLD = data.trendFlattenThreshold;
                // Liquidação automática por tendência é taker: só ligar depois de confirmar
                // a comissão realizada de taker com scripts/binance-audit.ts.
                if (data.trendFlattenEnabled !== undefined) {
                    mmCycle.TREND_FLATTEN_ENABLED = !!data.trendFlattenEnabled;
                    console.log(`⚠️ Trend auto-flatten (TAKER) ${mmCycle.TREND_FLATTEN_ENABLED ? "ATIVADO" : "desativado"}.`);
                }
                console.log(`🔧 Updated MM Params: Gamma=${inventoryManager.GAMMA}, Spread=${inventoryManager.BASE_SPREAD_PCT}, MaxSkew=${inventoryManager.MAX_INVENTORY_SKEW}, Target=${inventoryManager.INVENTORY_TARGET_BASE_PCT}`);
            } else if (data.type === "UPDATE_RISK_PARAMS") {
                if (data.maxDrawdownPct !== undefined) {
                    (riskManager as any).MAX_DRAWDOWN_PCT = data.maxDrawdownPct;
                    console.log(`🔧 Updated Risk Params: Max Drawdown=${data.maxDrawdownPct * 100}%`);
                }
            } else if (data.type === "UPDATE_LOT_CONFIG") {
                if (data.mode !== undefined) mmCycle.lotConfig.mode = data.mode;
                if (data.value !== undefined) mmCycle.lotConfig.value = data.value;
                console.log(`🔧 Updated Lot Config: Mode=${mmCycle.lotConfig.mode}, Value=${mmCycle.lotConfig.value}`);
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

    let pairSymbol = "";
    mmPair.applyBinanceSymbol(s => pairSymbol = s);
    const minNotional = precisionFetcher.getMinNotional(pairSymbol);

    const feeRate = currentMakerFee;
    const isZeroFeePromo = feeRate === 0;
    // Telemetria só lê; a coleta acontece no ciclo de market making.
    const volatilityPct = volatilityMonitor.getVolatilityPercentage(mmPair);

    // Get top of book prices
    let bestBid = 0;
    let bestAsk = 0;
    tick.applyTopBid((level) => { if (level) level.price.apply(v => bestBid = v); });
    tick.applyTopAsk((level) => { if (level) level.price.apply(v => bestAsk = v); });

    // Telemetria só lê; a coleta acontece no ciclo de market making.
    const trendSignal = trendMonitor.getTrendSignal(mmPair);
    const quotes = inventoryManager.getQuotes(
        midPrice, feeRate, volatilityPct, isZeroFeePromo, bestBid, bestAsk,
        tradeIntensityMonitor.getK(mmPair), trendSignal, trendMonitor.TREND_THRESHOLD
    );
    
    // Calculate total value of hanging orders
    const allHangingOrders = [...mmCycle.hangingBuyOrders, ...mmCycle.hangingSellOrders];
    const hangingOrdersValue = allHangingOrders.reduce((acc, o) => {
        return acc + (o.price * o.qty);
    }, 0);

    // Calculate active order statistics
    let activeBuyCount = 0;
    let activeBuyValue = 0;
    for (const o of mmCycle.activeBuyOrders) {
        if (o) {
            activeBuyCount++;
            activeBuyValue += (o.qty * o.price);
        }
    }
    
    let activeSellCount = 0;
    let activeSellValue = 0;
    for (const o of mmCycle.activeSellOrders) {
        if (o) {
            activeSellCount++;
            activeSellValue += (o.qty * o.price); // Represented in Quote currency for consistency
        }
    }

    const cooldown = mmCycle.getCooldownRemainingMs();

    server.publish("dashboard", JSON.stringify({
        type: "TELEMETRY",
        mode: currentMode,
        midPrice,
        bid: quotes.bids[0]?.price || 0, // Fallback for legacy display
        ask: quotes.asks[0]?.price || 0, // Fallback for legacy display
        bids: quotes.bids,
        asks: quotes.asks,
        q: quotes.q,
        reservationPrice: quotes.reservationPrice,
        baseBalance: inventoryManager.baseBalance,
        quoteBalance: inventoryManager.quoteBalance,
        baseSymbol: baseSym,
        quoteSymbol: quoteSym,
        gamma: inventoryManager.GAMMA,
        baseSpreadPct: inventoryManager.BASE_SPREAD_PCT,
        maxInventorySkew: inventoryManager.MAX_INVENTORY_SKEW,
        // null durante o backtest: a medida ficaria inflada pela starvation do event loop,
        // e o dashboard trata null como "--ms" em vez de exibir um valor falso.
        latency: isBacktestRunning ? null : currentLatency,
        totalFees: simExecutor.totalFeesCollected,
        effectiveSpread: quotes.effectiveSpread,
        minSpreadFloor: quotes.minSpreadFloor,
        volatilityPct: volatilityPct,
        lotMode: mmCycle.lotConfig.mode,
        lotValue: mmCycle.lotConfig.value,
        effectiveBuyLot: mmCycle.currentEffectiveBuyLotQuote,
        effectiveSellLot: mmCycle.currentEffectiveSellLotQuote,
        minNotional: minNotional,
        bidDistancePct: quotes.bidDistancePct,
        askDistancePct: quotes.askDistancePct,
        bidDistanceAbs: quotes.bidDistanceAbs,
        askDistanceAbs: quotes.askDistanceAbs,
        bestBid,
        bestAsk,
        isZeroFee: isZeroFeePromo,
        feeRate: currentMakerFee,
        safetyMultiplier: inventoryManager.SAFETY_MULTIPLIER,
        absoluteMinSpread: inventoryManager.ABSOLUTE_MIN_SPREAD,
        intensityK: tradeIntensityMonitor.getK(mmPair),
        killSwitchEngaged: riskManager.isKillSwitchEngaged,
        // Defesa de estoque: o dashboard precisa mostrar POR QUE um lado parou, senão um
        // veto de tendência é indistinguível de saldo insuficiente.
        inventoryTargetBasePct: inventoryManager.INVENTORY_TARGET_BASE_PCT,
        trendSignal,
        trendThreshold: trendMonitor.TREND_THRESHOLD,
        trendFlattenThreshold: trendMonitor.TREND_FLATTEN_THRESHOLD,
        trendFlattenEnabled: mmCycle.TREND_FLATTEN_ENABLED,
        bidVeto: quotes.bidVeto,
        askVeto: quotes.askVeto,
        hangingOrdersValue: hangingOrdersValue,
        hangingOrdersCount: allHangingOrders.length,
        activeBuyCount,
        activeBuyValue,
        activeSellCount,
        activeSellValue,
        buyCooldownMs: cooldown.buy,
        sellCooldownMs: cooldown.sell
    }));
}, 1000);

console.log(`🌐 WebSocket Server for Dashboard running on ws://localhost:${server.port}`);

async function executeBacktest(startTime: number, endTime: number, initialBalance: number) {
    if (isEngineRunning && currentMode === "LIVE") {
        console.log("Cannot start backtest while engine is running in LIVE mode.");
        return;
    }
    
    switchMode("BACKTEST");
    console.log(`🧪 Starting BACKTEST mode from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);
    
    // Clear previous simulation data
    TimeProvider.clearVirtualTime();
    simExecutor.setInitialBalances(0, initialBalance);
    simExecutor.totalFeesCollected = 0;
    
    const downloader = new BinanceHistoricalDownloader();
    let ticks: any[];
    try {
        server.publish("dashboard", JSON.stringify({ type: "BACKTEST_STATUS", status: "DOWNLOADING" }));
        let symbol = "";
        mmPair.applyBinanceSymbol(s => symbol = s);
        ticks = await downloader.downloadKlinesAsTicks(symbol, startTime, endTime);
    } catch (err: any) {
        server.publish("dashboard", JSON.stringify({ type: "BACKTEST_STATUS", status: "ERROR", message: err.message }));
        return;
    }
    
    server.publish("dashboard", JSON.stringify({ type: "BACKTEST_STATUS", status: "RUNNING" }));
    isBacktestRunning = true;
    try {
        const histIngestor = new HistoricalPriceIngestor();
        // Book sintético calibrado com a precisão real do símbolo, em vez do spread fixo de
        // 0,01% que era ~645× mais largo que o book verdadeiro do BTCFDUSD.
        let btSymbolForBook = "";
        mmPair.applyBinanceSymbol(s => btSymbolForBook = s);
        histIngestor.configureBook({
            tickSize: precisionFetcher.getPriceTickSize(btSymbolForBook),
            levelDepthQuote: simExecutor.queueAheadQuote,
        });
        histIngestor.subscribe(mmPair);
    
        histIngestor.onTick((tick) => {
            stateManager.updateState(tick);
        });

        let lastMMLoop = 0;

        for (let i = 0; i < ticks.length; i++) {
            const rawTick = ticks[i];
            histIngestor.emitHistoricalTick(rawTick);
        
            inventoryManager.baseBalance = simExecutor.baseBalance;
            inventoryManager.quoteBalance = simExecutor.quoteBalance;

            // Evaluate simulation fills on every historical tick
            const book = stateManager.retrieveOrderBook(mmPair);
            let bestBid = 0;
            let bestAsk = 0;
            if (book) {
                const tickObj = book.getLatest();
                if (tickObj) {
                    tickObj.applyTopBid((l) => { if (l) l.price.apply(v => bestBid = v); });
                    tickObj.applyTopAsk((l) => { if (l) l.price.apply(v => bestAsk = v); });
                    simExecutor.evaluateFills(bestBid, bestAsk, rawTick.volume, rawTick.low, rawTick.high);
                }
            }

            // Run MM loop every 2s of virtual time
            if (TimeProvider.now() - lastMMLoop >= 2000) {
                const feeRate = currentMakerFee;
                const isZeroFeePromo = feeRate === 0;
                volatilityMonitor.record(mmPair);
                const volatilityPct = volatilityMonitor.getVolatilityPercentage(mmPair);
                trendMonitor.record(mmPair);
                const trendSignal = trendMonitor.getTrendSignal(mmPair);
                const currentK = tradeIntensityMonitor.getK(mmPair);

                let btSymbol = "";
                mmPair.applyBinanceSymbol(s => btSymbol = s);
                const minNotional = precisionFetcher.getMinNotional(btSymbol);

                await mmCycle.executeTick(
                    mmPair, feeRate, volatilityPct, isZeroFeePromo, currentK, minNotional,
                    trendSignal, trendMonitor.TREND_THRESHOLD, trendMonitor.TREND_FLATTEN_THRESHOLD
                );
                lastMMLoop = TimeProvider.now();
            }
        
            if (i % 1000 === 0) {
                await new Promise(r => setImmediate(r));
                server.publish("dashboard", JSON.stringify({
                    type: "BACKTEST_PROGRESS",
                    progress: (i / ticks.length) * 100,
                    virtualTime: TimeProvider.now(),
                    baseBalance: simExecutor.baseBalance,
                    quoteBalance: simExecutor.quoteBalance,
                }));
            }
        }
    
        TimeProvider.clearVirtualTime();

        // Marca o estoque residual a mercado. Reportar só a perna em quote faz um bot que
        // terminou comprado parecer catastrófico: com 1000 de capital inicial, terminar
        // com 437 em quote e 0,0086 BTC é equity de ~990, não de 437.
        const finalPrice = ticks.length > 0 ? ticks[ticks.length - 1].price : 0;
        const finalBase = simExecutor.baseBalance;
        const finalQuote = simExecutor.quoteBalance;
        const finalEquity = finalQuote + (finalBase * finalPrice);
        const btcDrift = ticks.length > 1 ? (finalPrice - ticks[0].price) / ticks[0].price : 0;

        server.publish("dashboard", JSON.stringify({
            type: "BACKTEST_STATUS",
            status: "COMPLETED",
            initialBalance,
            finalBase,
            finalQuote,
            finalPrice,
            finalEquity,
            // Quanto o próprio ativo andou no período: sem isso não dá para separar
            // captura de spread de exposição direcional do estoque carregado.
            benchmarkDriftPct: btcDrift,
            totalFees: simExecutor.totalFeesCollected
        }));

        console.log(`✅ Backtest completed! Equity: ${finalEquity.toFixed(2)} (quote ${finalQuote.toFixed(2)} + base ${finalBase.toFixed(8)} @ ${finalPrice})`);
    } finally {
        // Precisa ser liberado mesmo se o laço lançar: preso em true, ele
        // desativaria a trava de latência no modo LIVE, que é justamente onde ela protege.
        isBacktestRunning = false;
        TimeProvider.clearVirtualTime();
    }
}
