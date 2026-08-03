import * as fs from "node:fs";
import * as os from "node:os";
import { ArbitrageCycle } from "./src/application/ArbitrageCycle";
import { ArbitrageMathEngine } from "./src/application/ArbitrageMathEngine";
import { CycleEvaluator } from "./src/application/CycleEvaluator";
import { CycleExecutor } from "./src/application/CycleExecutor";
import { ExecutionLock } from "./src/application/ExecutionLock";
import { LocalStateManager } from "./src/application/LocalStateManager";
import { Amount } from "./src/domain/valueObjects/Amount";
import { Currency } from "./src/domain/valueObjects/Currency";
import { Pair } from "./src/domain/valueObjects/Pair";
import { TradingMode } from "./src/domain/valueObjects/TradingMode";
import { BinanceAutoScanner } from "./src/infrastructure/BinanceAutoScanner";
import { BinanceBalanceFetcher } from "./src/infrastructure/BinanceBalanceFetcher";
import { BinanceFeeFetcher } from "./src/infrastructure/BinanceFeeFetcher";
import { BinanceOrderExecutor } from "./src/infrastructure/BinanceOrderExecutor";
import { BinancePrecisionFetcher } from "./src/infrastructure/BinancePrecisionFetcher";
import { BinancePriceIngestor } from "./src/infrastructure/BinancePriceIngestor";
import { BinanceWsClient } from "./src/infrastructure/BinanceWsClient";
import {
	AsyncWriterFactory,
	DatabaseFactory,
	DatabaseFilePath,
} from "./src/infrastructure/database/DatabaseConnection";
import { ErrorLogRepository } from "./src/infrastructure/database/ErrorLogRepository";
import { TickRepository } from "./src/infrastructure/database/TickRepository";
import { TransactionRepository } from "./src/infrastructure/database/TransactionRepository";
import { SimulatedOrderExecutor } from "./src/infrastructure/SimulatedOrderExecutor";
import { VirtualBalanceManager } from "./src/infrastructure/VirtualBalanceManager";

let lastCpuInfo = os.cpus();
function getCpuUsage(): number {
	const currentCpuInfo = os.cpus();
	let idleDiff = 0;
	let totalDiff = 0;
	for (let i = 0; i < currentCpuInfo.length; i++) {
		const current = currentCpuInfo[i]?.times;
		const last = lastCpuInfo[i]?.times;
		if (!current || !last) continue;
		const currentTotal = Object.values(current).reduce((a, b) => a + b, 0);
		const lastTotal = Object.values(last).reduce((a, b) => a + b, 0);
		idleDiff += current.idle - last.idle;
		totalDiff += currentTotal - lastTotal;
	}
	lastCpuInfo = currentCpuInfo;
	if (totalDiff === 0) return 0;
	return 100 - (idleDiff / totalDiff) * 100;
}

function getDiskUsage(): number {
	try {
		const stats = fs.statfsSync("/");
		const total = stats.blocks * stats.bsize;
		const free = stats.bfree * stats.bsize;
		if (total === 0) return 0;
		return ((total - free) / total) * 100;
	} catch (_e) {
		return 0;
	}
}

const latestErrors: string[] = [];
const originalConsoleError = console.error;
console.error = (...args) => {
	const msg = args
		.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
		.join(" ");
	latestErrors.push(msg);
	if (latestErrors.length > 10) latestErrors.shift();
	originalConsoleError(...args);
};

console.log("🚀 Starting HFT Triangular Arbitrage Engine...");

const envMode =
	process.env.TRADING_MODE === "LIVE"
		? TradingMode.LIVE
		: TradingMode.SIMULATION;
let currentMode = envMode;

const initialSimBalanceEnv = parseFloat(
	process.env.SIMULATION_BALANCE || "1000",
);
let virtualBalanceManager = new VirtualBalanceManager(
	new Amount(initialSimBalanceEnv),
);

let bnbDiscountEnabled = process.env.BNB_DISCOUNT === "true";
let isEngineRunning = false;
let isTickLoggerRunning = true;
const bnbBlacklist = new Set<string>();

const dbPath = new DatabaseFilePath("./hft.sqlite");
const db = DatabaseFactory.create(dbPath);
const asyncWriter = AsyncWriterFactory.create(db);
const transactionRepo = new TransactionRepository(asyncWriter);
const errorRepo = new ErrorLogRepository(asyncWriter);
const tickRepo = new TickRepository(asyncWriter);

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

const binanceExecutor = new BinanceOrderExecutor(
	globalWsClient,
	errorRepo,
	transactionRepo,
	precisionFetcher,
);
let simulatedExecutor = new SimulatedOrderExecutor(
	stateManager,
	virtualBalanceManager,
	transactionRepo,
	() => currentLatency,
);

const getExecutor = () => {
	return currentMode.isLive() ? binanceExecutor : simulatedExecutor;
};

const cycleEvaluator = new CycleEvaluator(
	stateManager,
	mathEngine,
	precisionFetcher,
);
const cycleExecutor = new CycleExecutor(
	getExecutor,
	errorRepo,
	transactionRepo,
);
const arbitrageCycle = new ArbitrageCycle(cycleEvaluator, cycleExecutor);

const _brl = new Currency("BRL");
const _eth = new Currency("ETH");
const _btc = new Currency("BTC");

async function startHftEngine() {
	const scanner = new BinanceAutoScanner();
	const activeTriangles = await scanner.scanTriangles("USDT", "BRL");

	if (activeTriangles.length === 0) {
		console.error(
			"❌ Fatal Error: AutoScanner returned 0 triangles. Check your internet or Binance API status.",
		);
		process.exit(1);
	}

	activeTriangles.forEach((t) => {
		t.apply((first, second, third) => {
			stateManager.registerPair(first);
			stateManager.registerPair(second);
			stateManager.registerPair(third);

			ingestor.subscribe(first);
			ingestor.subscribe(second);
			ingestor.subscribe(third);
		});
	});

	// Adiciona BNBUSDT para calcular a regra de desconto do BNB (< 0.00000001)
	const bnbUsdtPair = new Pair(new Currency("BNB"), new Currency("USDT"));
	stateManager.registerPair(bnbUsdtPair);
	ingestor.subscribe(bnbUsdtPair);

	// Preload fees before processing ticks to avoid latency
	const pairsList: Pair[] = [];
	activeTriangles.forEach((t) =>
		t.apply((f, s, thirdPair) => pairsList.push(f, s, thirdPair)),
	);
	await feeFetcher.preloadFees(pairsList);
	await precisionFetcher.preloadPrecisions();

	const MIN_PROFIT_PERCENTAGE = 0.0005; // 0.05% of the applied lot size as minimum net profit

	let realBalance = 0;
	let realBnbBalance = 0;
	let bnbDiscountLocked = false;
	let bnbPriceBrl = 3000; // Valor aproximado padrão (atualizado periodicamente)
	const executedVolume = 0;
	let latestPnl = 0;
	let bestTrianglePair = "pepebrl";

	const evaluationLock = new ExecutionLock();

	ingestor.onTick(async (tick) => {
		stateManager.updateState(tick);

		// Arquiva no banco de dados independentemente do estado do motor, desde que esteja ativo
		if (isTickLoggerRunning) {
			tickRepo.saveTick(tick);
		}

		await evaluationLock.runIfUnlocked(async () => {
			if (!isEngineRunning) return;

			try {
				let currentUsableBalance = 1000;
				if (currentMode.isLive()) {
					currentUsableBalance = realBalance > 0 ? realBalance : 0;
				} else {
					virtualBalanceManager.applyAllBalances((simBalances) => {
						currentUsableBalance = simBalances.get("BRL") || 1000;
					});
				}

				// ── Smart Lot Scanner ──────────────────────────────────────
				// Gera lotes candidatos de maior para menor.
				// Percentuais do saldo: 99%, 50%, 25%, 10%, 5%
				// Valores fixos mínimos: R$200, R$100, R$50, R$25, R$11
				const percentageLots = [0.99, 0.5, 0.25, 0.1, 0.05]
					.map((p) => currentUsableBalance * p)
					.filter((v) => v >= 11); // Binance minimum ~ R$11

				const fixedLots = [200, 100, 50, 25, 11].filter(
					(v) => v <= currentUsableBalance,
				);

				// Mescla, deduplica por proximidade, e ordena decrescente
				const allCandidates = [...percentageLots, ...fixedLots];
				const seen = new Set<number>();
				const lotSizes: number[] = [];
				for (const v of allCandidates) {
					const rounded = Math.floor(v * 100) / 100;
					if (rounded >= 11 && !seen.has(rounded)) {
						seen.add(rounded);
						lotSizes.push(rounded);
					}
				}
				lotSizes.sort((a, b) => b - a);

				if (lotSizes.length === 0) return;

				// ── Fase 1: Sondar todos os triângulos × lotes (sem executar) ──
				let bestProfit = -9999999;
				let bestLotSize = 0;
				let bestTriangleIdx = -1;

				for (let ti = 0; ti < activeTriangles.length; ti++) {
					const triangle = activeTriangles[ti]!;

					if (bnbDiscountEnabled) {
						let baseSym = "";
						triangle.third.applyCurrencies((base) =>
							base.applySymbol((s) => (baseSym = s)),
						);
						if (bnbBlacklist.has(baseSym)) continue;
					}

					for (const lot of lotSizes) {
						const candidateAmount = new Amount(lot);
						const profit = arbitrageCycle.evaluateOnly(
							triangle,
							feeFetcher,
							mathEngine,
							candidateAmount,
							bnbDiscountEnabled,
							stateManager,
						);

						let profitVal = -9999999;
						profit.apply((v) => (profitVal = v));

						if (profitVal > bestProfit) {
							bestProfit = profitVal;
							bestLotSize = lot;
							bestTriangleIdx = ti;
						}

						// Se este lote já é lucrativo, não precisa testar lotes menores
						// para este triângulo (lote maior = mais lucro absoluto quando viável)
						const minProfitVal = lot * MIN_PROFIT_PERCENTAGE;
						if (profitVal > minProfitVal) break;
					}
				}

				// ── Fase 2: Executar o melhor candidato (se lucrativo) ──
				if (bestTriangleIdx >= 0 && bestProfit > 0) {
					const minProfitVal = bestLotSize * MIN_PROFIT_PERCENTAGE;

					const winnerTriangle = activeTriangles[bestTriangleIdx]!;

					if (bestProfit > minProfitVal && winnerTriangle) {
						const winnerAmount = new Amount(bestLotSize);
						const dynamicMinProfit = new Amount(minProfitVal);

						console.log(
							`💰 Smart Lot: Executing R$${bestLotSize.toFixed(2)} on triangle #${bestTriangleIdx} (projected profit: R$${bestProfit.toFixed(4)})`,
						);

						const actualProfit = await arbitrageCycle.evaluateAndExecute(
							winnerTriangle,
							feeFetcher,
							mathEngine,
							winnerAmount,
							dynamicMinProfit,
							bnbDiscountEnabled,
							stateManager,
						);

						let realProfitVal = 0;
						actualProfit.apply((v) => (realProfitVal = v));

						latestPnl = realProfitVal;
						winnerTriangle.third.applyBinanceSymbol(
							(sym) => (bestTrianglePair = sym.toLowerCase()),
						);
					} else {
						latestPnl = bestProfit;
						if (winnerTriangle) {
							winnerTriangle.third.applyBinanceSymbol(
								(sym) => (bestTrianglePair = sym.toLowerCase()),
							);
						}
					}
				} else {
					latestPnl = bestProfit > -999999 ? bestProfit : 0;
				}
			} catch (err) {
				console.error("Evaluation error:", err);
			}
		});
	});

	balanceFetcher.fetchBalances().then((balances) => {
		balances.brl.apply((val) => {
			realBalance = val;
		});
		balances.bnb.apply((val) => {
			realBnbBalance = val;
		});
		cycleExecutor.initializeDust(balances.dust);
	});

	setInterval(async () => {
		try {
			const pingStart = Date.now();
			const balances = await balanceFetcher.fetchBalances();
			currentLatency = Date.now() - pingStart;

			balances.brl.apply((val) => {
				realBalance = val;
			});
			balances.bnb.apply((val) => {
				realBnbBalance = val;
			});
		} catch (_err) {}
	}, 5000);

	console.log("✅ Initialization Complete.");
	console.log(
		"📡 Listening for market data and evaluating Arbitrage Cycles...",
	);

	const _currentBasePrice = 45200.5;
	const _currentPnl = 1250.0;
	const _currentVolume = 1450200;

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
						currentMode =
							data.mode === "LIVE" ? TradingMode.LIVE : TradingMode.SIMULATION;
						console.log(`Switched trading mode to ${data.mode}`);
					} else if (data.type === "SET_SIM_BALANCE") {
						virtualBalanceManager = new VirtualBalanceManager(
							new Amount(parseFloat(data.amount)),
						);
						simulatedExecutor = new SimulatedOrderExecutor(
							stateManager,
							virtualBalanceManager,
							transactionRepo,
						);
						console.log(`Reset simulation balance to ${data.amount}`);
					} else if (data.type === "SET_BNB_DISCOUNT") {
						if (data.enabled === true && bnbDiscountLocked) {
							console.log(
								`⚠️ Blocked attempt to enable BNB Discount. Insufficient BNB balance.`,
							);
							// Força envio de status para o cliente reverter a chave visualmente
							ws.send(
								JSON.stringify({
									type: "STATUS",
									mode: currentMode.isLive() ? "LIVE" : "SIMULATION",
									simBalance: initialSimBalanceEnv,
									realBalance: realBalance,
									bnbDiscount: bnbDiscountEnabled,
									isRunning: isEngineRunning,
									bnbBalance: realBnbBalance,
									bnbDiscountLocked: bnbDiscountLocked,
								}),
							);
							return;
						}
						const oldValue = bnbDiscountEnabled;
						bnbDiscountEnabled = data.enabled === true;
						console.log(
							`💰 BNB Discount: ${oldValue ? "ON" : "OFF"} → ${bnbDiscountEnabled ? "ON ✅ (fees x0.75)" : "OFF"}`,
						);
					} else if (data.type === "TOGGLE_ENGINE") {
						isEngineRunning = data.running === true;
						console.log(
							`Engine running state: ${isEngineRunning ? "ACTIVE 🟢" : "HALTED 🔴"}`,
						);
					} else if (data.type === "TOGGLE_TICK_LOGGER") {
						isTickLoggerRunning = data.running === true;
						console.log(
							`Tick Logger state: ${isTickLoggerRunning ? "ACTIVE 🟢" : "HALTED 🔴"}`,
						);
					} else if (data.type === "GET_STATUS") {
						let modeStr = "";
						currentMode.apply((m) => (modeStr = m));

						virtualBalanceManager.applyAllBalances((simBalances) => {
							const simBrl = simBalances.get("BRL") || 0;
							ws.send(
								JSON.stringify({
									type: "STATUS",
									mode: modeStr,
									simBalance: simBrl,
									realBalance: realBalance,
									bnbDiscount: bnbDiscountEnabled,
									isRunning: isEngineRunning,
									isTickLoggerRunning,
									bnbBalance: realBnbBalance,
									bnbDiscountLocked: bnbDiscountLocked,
									blacklistedCount: bnbBlacklist.size,
								}),
							);
						});
					}
				} catch (_e) {}
			},
			open(ws) {
				ws.subscribe("dashboard");
				console.log("🖥️ Dashboard connected.");
			},
			close(_ws) {
				console.log("🖥️ Dashboard disconnected.");
			},
		},
	});

	console.log(
		`🌐 WebSocket Server for Dashboard running on ws://localhost:${server.port}`,
	);

	// Telemetry loop: Publishes state to frontend 4 times per second
	// Atualiza o preço do BNB periodicamente
	setInterval(async () => {
		try {
			const res = await fetch(
				"https://api.binance.com/api/v3/ticker/price?symbol=BNBBRL",
			);
			if (res.ok) {
				const data: any = await res.json();
				if (data.price) bnbPriceBrl = parseFloat(data.price);
			}
		} catch (_e) {}
	}, 60000);

	// BNB Discount Dynamic Blacklist Updater
	setInterval(() => {
		if (!bnbDiscountEnabled) return;

		const bnbTick = stateManager.retrieveOrderBook(
			new Pair(new Currency("BNB"), new Currency("USDT")),
		);
		let bnbPriceUsdt = 0;
		if (bnbTick?.getLatest()) {
			bnbTick.getLatest()?.applyTopAsk((topAsk) => {
				if (topAsk) topAsk.price.apply((p) => (bnbPriceUsdt = p));
			});
		}
		if (bnbPriceUsdt === 0) return;

		activeTriangles.forEach((t) => {
			let baseSym = "";
			t.third.applyCurrencies((base) => base.applySymbol((s) => (baseSym = s)));

			t.third.applyCurrencies((base) => {
				const baseTick = stateManager.retrieveOrderBook(
					new Pair(base, new Currency("USDT")),
				);
				if (baseTick?.getLatest()) {
					baseTick.getLatest()?.applyTopAsk((baseAsk) => {
						if (baseAsk) {
							let basePriceUsdt = 0;
							baseAsk.price.apply((p) => (basePriceUsdt = p));
							const priceInBnb = basePriceUsdt / bnbPriceUsdt;
							if (priceInBnb < 0.00000001) {
								bnbBlacklist.add(baseSym);
							} else {
								bnbBlacklist.delete(baseSym);
							}
						}
					});
				}
			});
		});
	}, 15000);

	setInterval(async () => {
		let modeStr = "";
		currentMode.apply((m) => (modeStr = m));
		if (modeStr === "LIVE") {
			const balances = await balanceFetcher.fetchBalances();
			balances.brl.apply((val) => (realBalance = val));
			balances.bnb.apply((val) => (realBnbBalance = val));

			// Calcula BNB necessário (0.225% do BRL atual)
			const requiredBnbInBrl = realBalance * 0.00225;
			const requiredBnb = requiredBnbInBrl / bnbPriceBrl;

			bnbDiscountLocked = realBnbBalance < requiredBnb;

			if (bnbDiscountLocked && bnbDiscountEnabled) {
				bnbDiscountEnabled = false;
				console.log(
					`⚠️ BNB Discount automatically DISABLED! Insufficient BNB balance. Required: ${requiredBnb.toFixed(6)} BNB.`,
				);
			}
		}
	}, 2000);

	setInterval(() => {
		let modeStr = "";
		currentMode.apply((m) => (modeStr = m));

		let simBrl = 0;
		if (currentMode.isSimulation()) {
			virtualBalanceManager.applyAllBalances((simBalances) => {
				simBrl = simBalances.get("BRL") || 0;
			});
		}

		const totalRam = os.totalmem();
		const freeRam = os.freemem();
		const ramUsage = totalRam > 0 ? ((totalRam - freeRam) / totalRam) * 100 : 0;

		const vpsStats = {
			cpu: getCpuUsage(),
			ram: ramUsage,
			storage: getDiskUsage(),
		};

		server.publish(
			"dashboard",
			JSON.stringify({
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
				isTickLoggerRunning: isTickLoggerRunning,
				errors: latestErrors,
				bnbBalance: realBnbBalance,
				bnbDiscountLocked: bnbDiscountLocked,
				blacklistedCount: bnbBlacklist.size,
				vpsStats: vpsStats,
			}),
		);
	}, 50);
} // End of startHftEngine

startHftEngine().catch((e) => {
	console.error("❌ HFT Engine crashed:", e);
	process.exit(1);
});
