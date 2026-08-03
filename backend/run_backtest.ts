import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArbitrageCycle } from "./src/application/ArbitrageCycle";
import { ArbitrageMathEngine } from "./src/application/ArbitrageMathEngine";
import { CycleEvaluator } from "./src/application/CycleEvaluator";
import { CycleExecutor } from "./src/application/CycleExecutor";
import { LocalStateManager } from "./src/application/LocalStateManager";
import { PairTuple, TriangularPairs } from "./src/application/TriangularPairs";
import { Amount } from "./src/domain/valueObjects/Amount";
import { Currency } from "./src/domain/valueObjects/Currency";
import { Pair } from "./src/domain/valueObjects/Pair";
import { Tick } from "./src/domain/valueObjects/Tick";
import { BinanceFeeFetcher } from "./src/infrastructure/BinanceFeeFetcher";
import { BinancePrecisionFetcher } from "./src/infrastructure/BinancePrecisionFetcher";
import {
	AsyncWriterFactory,
	DatabaseFactory,
	DatabaseFilePath,
} from "./src/infrastructure/database/DatabaseConnection";
import { ErrorLogRepository } from "./src/infrastructure/database/ErrorLogRepository";
import { TransactionRepository } from "./src/infrastructure/database/TransactionRepository";
import { SimulatedOrderExecutor } from "./src/infrastructure/SimulatedOrderExecutor";
import { VirtualBalanceManager } from "./src/infrastructure/VirtualBalanceManager";

async function runBacktest() {
	console.log("🚀 Starting Backtest Engine...");

	// 1. Load Data
	const PAIRS = ["BTCUSDT", "USDTBRL", "BTCBRL"];
	const dataMap = new Map<string, any[]>();
	let _totalTicks = 0;

	for (const pair of PAIRS) {
		const filePath = join(process.cwd(), "data", `${pair}_2days.json`);
		const fileContent = readFileSync(filePath, "utf-8");
		const arr = JSON.parse(fileContent);
		dataMap.set(pair, arr);
		_totalTicks += arr.length;
		console.log(`Loaded ${arr.length} ticks for ${pair}`);
	}

	// 2. Setup Dependencies
	const stateManager = new LocalStateManager();
	const precisionFetcher = new BinancePrecisionFetcher();
	await precisionFetcher.preloadPrecisions(); // Need actual precisions for truncation

	const feeFetcher = new BinanceFeeFetcher();
	await feeFetcher.preloadFees([
		new Pair(new Currency("BTC"), new Currency("USDT")),
		new Pair(new Currency("USDT"), new Currency("BRL")),
		new Pair(new Currency("BTC"), new Currency("BRL")),
	]);

	const mathEngine = new ArbitrageMathEngine();
	const cycleEvaluator = new CycleEvaluator(
		stateManager,
		mathEngine,
		precisionFetcher,
	);

	const virtualBalanceManager = new VirtualBalanceManager(new Amount(1000));

	const dbPath = new DatabaseFilePath("./backtest.sqlite");
	const db = DatabaseFactory.create(dbPath);
	const asyncWriter = AsyncWriterFactory.create(db);
	const transactionRepo = new TransactionRepository(asyncWriter);
	const errorRepo = new ErrorLogRepository(asyncWriter);

	// We only use the simulated executor for backtests
	const simulatedExecutor = new SimulatedOrderExecutor(
		stateManager,
		virtualBalanceManager,
		transactionRepo,
		() => 0,
	);
	const cycleExecutor = new CycleExecutor(
		() => simulatedExecutor,
		errorRepo,
		transactionRepo,
	);

	const arbitrageCycle = new ArbitrageCycle(cycleEvaluator, cycleExecutor);

	const MIN_PROFIT_PERCENTAGE = 0.0005; // 0.05%

	const triangle = new TriangularPairs(
		new PairTuple(
			new Pair(new Currency("USDT"), new Currency("BRL")),
			new Pair(new Currency("BTC"), new Currency("USDT")),
		),
		new Pair(new Currency("BTC"), new Currency("BRL")),
	);

	const firstPair: Pair = triangle.pairTuple.first;
	const secondPair: Pair = triangle.pairTuple.second;
	const thirdPair: Pair = triangle.third;

	stateManager.registerPair(firstPair);
	stateManager.registerPair(secondPair);
	stateManager.registerPair(thirdPair);

	// 3. Synchronize and emit ticks
	// Since all klines have the exact same timestamps (multiples of 1000),
	// we can group them by timestamp and emit them together.

	const pointers = { BTCUSDT: 0, USDTBRL: 0, BTCBRL: 0 };
	const arrBtcUsdt = dataMap.get("BTCUSDT")!;
	const arrUsdtBrl = dataMap.get("USDTBRL")!;
	const arrBtcBrl = dataMap.get("BTCBRL")!;

	let executedTrades = 0;
	let totalProcessed = 0;

	console.log("\n⏳ Simulating 2 days of market data...");
	const startTime = Date.now();

	while (
		pointers.BTCUSDT < arrBtcUsdt.length &&
		pointers.USDTBRL < arrUsdtBrl.length &&
		pointers.BTCBRL < arrBtcBrl.length
	) {
		const kline1 = arrBtcUsdt[pointers.BTCUSDT];
		const kline2 = arrUsdtBrl[pointers.USDTBRL];
		const kline3 = arrBtcBrl[pointers.BTCBRL];

		const minTime = Math.min(kline1.t, kline2.t, kline3.t);

		let updated = false;

		// We simulate a massive liquidity pool (e.g. 100 base asset) at the close price
		const createTick = (pair: Pair, price: number) => {
			const p = new Amount(price);
			const q = new Amount(100);
			return new Tick(pair, [{ price: p, qty: q }], [{ price: p, qty: q }]);
		};

		if (kline2.t === minTime) {
			stateManager.updateState(createTick(firstPair, kline2.c));
			pointers.USDTBRL++;
			updated = true;
		}
		if (kline1.t === minTime) {
			stateManager.updateState(createTick(secondPair, kline1.c));
			pointers.BTCUSDT++;
			updated = true;
		}
		if (kline3.t === minTime) {
			stateManager.updateState(createTick(thirdPair, kline3.c));
			pointers.BTCBRL++;
			updated = true;
		}

		if (updated) {
			totalProcessed++;

			// Evaluate just like the main bot
			let currentUsableBalance = 0;
			virtualBalanceManager.applyAllBalances((simBalances) => {
				currentUsableBalance = simBalances.get("BRL") || 1000;
			});

			const percentageLots = [0.99, 0.5, 0.25, 0.1, 0.05]
				.map((p) => currentUsableBalance * p)
				.filter((v) => v >= 11);

			const fixedLots = [200, 100, 50, 25, 11].filter(
				(v) => v <= currentUsableBalance,
			);

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

			let bestProfit = -9999999;
			let bestLotSize = 0;

			for (const lot of lotSizes) {
				const candidateAmount = new Amount(lot);
				const profit = arbitrageCycle.evaluateOnly(
					triangle,
					feeFetcher,
					mathEngine,
					candidateAmount,
					true, // bnb discount ENABLED
					stateManager,
				);

				let profitVal = -9999999;
				profit.apply((v) => (profitVal = v));

				if (profitVal > bestProfit) {
					bestProfit = profitVal;
					bestLotSize = lot;
				}

				const minProfitVal = lot * MIN_PROFIT_PERCENTAGE;
				if (profitVal > minProfitVal) break;
			}

			if (bestProfit > 0) {
				const minProfitVal = bestLotSize * MIN_PROFIT_PERCENTAGE;
				if (bestProfit > minProfitVal) {
					const winnerAmount = new Amount(bestLotSize);
					const dynamicMinProfit = new Amount(minProfitVal);

					await arbitrageCycle.evaluateAndExecute(
						triangle,
						feeFetcher,
						mathEngine,
						winnerAmount,
						dynamicMinProfit,
						true, // bnb discount ENABLED
						stateManager,
					);
					executedTrades++;
				}
			}
		}
	}

	const duration = (Date.now() - startTime) / 1000;

	console.log("\n=============================================");
	console.log("✅ BACKTEST COMPLETED");
	console.log("=============================================");
	console.log(`⏱️  Simulation took: ${duration.toFixed(2)} seconds`);
	console.log(`📊 Total Market Ticks Processed: ${totalProcessed}`);
	console.log(`⚡ Total Arbitrage Trades Executed: ${executedTrades}`);

	let finalBalance = 0;
	virtualBalanceManager.applyAllBalances((balances) => {
		finalBalance = balances.get("BRL") || 0;
	});

	console.log("\n💰 RESULTADOS FINANCEIOS:");
	console.log(`   Saldo Inicial: R$ 1000.00`);
	console.log(`   Saldo Final:   R$ ${finalBalance.toFixed(2)}`);

	const netProfit = finalBalance - 1000;
	if (netProfit > 0) {
		console.log(
			`   🟢 LUCRO LÍQUIDO: R$ ${netProfit.toFixed(2)} (+${((netProfit / 1000) * 100).toFixed(2)}%)`,
		);
	} else if (netProfit < 0) {
		console.log(
			`   🔴 PREJUÍZO: R$ ${Math.abs(netProfit).toFixed(2)} (${((netProfit / 1000) * 100).toFixed(2)}%)`,
		);
	} else {
		console.log(`   ⚪ EMPATE (Sem oportunidades lucrativas)`);
	}

	console.log("=============================================\n");
	process.exit(0);
}

runBacktest().catch(console.error);
