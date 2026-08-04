import { Currency } from "../src/domain/valueObjects/Currency";
import { Pair } from "../src/domain/valueObjects/Pair";
import { TriangularPairs, PairTuple } from "../src/application/TriangularPairs";
import { Amount } from "../src/domain/valueObjects/Amount";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { ArbitrageMathEngine } from "../src/application/ArbitrageMathEngine";
import { CycleEvaluator } from "../src/application/CycleEvaluator";
import { CycleExecutor } from "../src/application/CycleExecutor";
import { ArbitrageCycle } from "../src/application/ArbitrageCycle";
import { FeeFetcher } from "../src/domain/interfaces/FeeFetcher";
import { Fee } from "../src/domain/valueObjects/Fee";
import { Tick } from "../src/domain/valueObjects/Tick";

class MockFeeFetcher implements FeeFetcher {
    preloadFees(pairs: Pair[]): Promise<void> { return Promise.resolve(); }
    getFeeFor(pair: Pair): Fee { return new Fee(new Amount(0.001)); }
}

const stateManager = new LocalStateManager();
const mathEngine = new ArbitrageMathEngine();
const cycleEvaluator = new CycleEvaluator(stateManager, mathEngine);
const mockExecutor = { executeCycle: async () => {} } as any;
const cycleExecutor = new CycleExecutor(() => mockExecutor, null as any, null as any);
const arbitrageCycle = new ArbitrageCycle(cycleEvaluator, cycleExecutor);

const brl = new Currency("BRL");
const usdt = new Currency("USDT");

// Criando 17 triângulos
const activeTriangles: TriangularPairs[] = [];
for (let i = 0; i < 17; i++) {
    const base = new Currency(`COIN${i}`);
    activeTriangles.push(new TriangularPairs(
        new PairTuple(new Pair(usdt, brl), new Pair(base, usdt)),
        new Pair(base, brl)
    ));
}

// Preenchendo o StateManager com Ticks
stateManager.updateState(new Tick(new Pair(usdt, brl), [{price: new Amount(5), qty: new Amount(1000)}], [{price: new Amount(5), qty: new Amount(1000)}]));
stateManager.updateState(new Tick(new Pair(new Currency("BNB"), usdt), [{price: new Amount(550), qty: new Amount(10)}], [{price: new Amount(550), qty: new Amount(10)}]));

for (let i = 0; i < 17; i++) {
    const base = new Currency(`COIN${i}`);
    stateManager.updateState(new Tick(new Pair(base, usdt), [{price: new Amount(2), qty: new Amount(100)}], [{price: new Amount(2), qty: new Amount(100)}]));
    stateManager.updateState(new Tick(new Pair(base, brl), [{price: new Amount(10), qty: new Amount(100)}], [{price: new Amount(10), qty: new Amount(100)}]));
}

async function runBenchmark() {
    const feeFetcher = new MockFeeFetcher();
    const minProfit = new Amount(0.10);
    const bnbDiscountEnabled = true;

    // Gerando lotes idênticos ao código de produção (para 1000 de banca)
    const currentUsableBalance = 1000;
    const percentageLots = [0.99, 0.50, 0.25, 0.10, 0.05]
        .map(p => currentUsableBalance * p)
        .filter(v => v >= 11);
    const fixedLots = [200, 100, 50, 25, 11]
        .filter(v => v <= currentUsableBalance);
    
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
    
    // Warm-up loop
    for (let i = 0; i < 1000; i++) {
        for (const triangle of activeTriangles) {
            for (const lot of lotSizes) {
                arbitrageCycle.evaluateOnly(triangle, feeFetcher, mathEngine, new Amount(lot), bnbDiscountEnabled, stateManager);
            }
        }
    }

    const iterations = 10000;
    const start = process.hrtime.bigint();
    
    for (let i = 0; i < iterations; i++) {
        let bestProfit = -9999999;
        
        for (let ti = 0; ti < activeTriangles.length; ti++) {
            const triangle = activeTriangles[ti]!;

            for (const lot of lotSizes) {
                const profit = arbitrageCycle.evaluateOnly(triangle, feeFetcher, mathEngine, new Amount(lot), bnbDiscountEnabled, stateManager);
                let profitVal = -9999999;
                profit.apply(v => profitVal = v);

                if (profitVal > bestProfit) {
                    bestProfit = profitVal;
                }

                let minProfitVal = 0;
                minProfit.apply(v => minProfitVal = v);
                if (profitVal > minProfitVal) break;
            }
        }
    }
    
    const end = process.hrtime.bigint();
    const totalNs = end - start;
    const totalMs = Number(totalNs) / 1e6;
    
    const timePerFullLoopMs = totalMs / iterations;
    
    console.log(`[BENCHMARK] Smart Lot Scanner processando ${activeTriangles.length} triângulos × ~${lotSizes.length} lotes:`);
    console.log(`⏱️ Tempo médio interno para analisar todas combinações num único tick: ${timePerFullLoopMs.toFixed(5)} ms`);
    console.log(`⏱️ Se a API da AWS tem 4.00 ms, essa conta ocupa apenas ${(timePerFullLoopMs / 4 * 100).toFixed(2)}% do tempo da rede.`);
}

runBenchmark().catch(console.error);
