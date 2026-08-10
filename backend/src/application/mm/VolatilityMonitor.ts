import { LocalStateManager } from "../LocalStateManager";
import { Pair } from "../../domain/valueObjects/Pair";
import { TimeProvider } from "../../infrastructure/TimeProvider";

/**
 * Mede volatilidade como desvio-padrão de RETORNOS, escalado para o horizonte em que
 * ficamos expostos com uma cotação parada.
 *
 * A versão anterior media a dispersão do *nível* de preço sobre a média da janela
 * (stddev(preços)/média). Isso não é volatilidade: num mercado em tendência limpa, sem
 * nenhum ruído, aquele número explode — e como ele alimenta o piso de spread
 * (SAFETY_MULTIPLIER × vol), o bot alargava o spread justamente quando deveria estar
 * ajustando estoque, e o apertava em mercados laterais ruidosos.
 *
 * Além disso o getter antigo MUTAVA o histórico a cada chamada, e era chamado 2–3× por
 * ciclo (loop principal, circuit breaker e telemetria). A estimativa dependia de quantas
 * vezes alguém tinha perguntado. Agora a coleta é explícita: `record()` amostra,
 * `getVolatilityPercentage()` apenas lê.
 */
export class VolatilityMonitor {
    private readonly WINDOW_MS = 60000;

    /**
     * Horizonte de exposição, em segundos. É o tempo típico que uma cotação fica parada
     * antes de ser reposicionada, então casa com ORDER_REFRESH_TIME_MS do MarketMakerCycle.
     * A volatilidade retornada é o desvio esperado do preço ao longo desse período.
     */
    private readonly HORIZON_SECONDS = 30;

    /**
     * Movimento esperado no horizonte a partir do qual paramos de cotar. Em condições
     * normais o BTC roda perto de 0,03% por 30s, então 0,5% representa uma dislocação
     * real, não ruído. (O limite antigo de 2% era sobre outra escala de medida e, com
     * retornos, nunca dispararia.)
     */
    private readonly THRESHOLD = 0.005;

    private priceHistory: { ts: number; price: number }[] = [];

    constructor(private stateManager: LocalStateManager) {}

    /** Coleta uma amostra. Deve ser chamado exatamente uma vez por ciclo. */
    public record(pair: Pair): void {
        const book = this.stateManager.retrieveOrderBook(pair);
        if (!book) return;
        const latest = book.getLatest();
        if (!latest) return;

        const midPriceAmount = latest.getMidPrice();
        if (!midPriceAmount) return;

        let mid = 0;
        midPriceAmount.apply((v: number) => mid = v);
        if (mid <= 0) return;

        const now = TimeProvider.now();
        const last = this.priceHistory[this.priceHistory.length - 1];
        // Amostras no mesmo milissegundo produziriam dt = 0 e variância infinita.
        if (last && last.ts === now) return;

        this.priceHistory.push({ ts: now, price: mid });

        const cutoff = now - this.WINDOW_MS;
        while (this.priceHistory.length && this.priceHistory[0]!.ts < cutoff) {
            this.priceHistory.shift();
        }
    }

    /**
     * Desvio-padrão esperado do preço ao longo de HORIZON_SECONDS, como fração.
     * Puro: não altera estado.
     */
    public getVolatilityPercentage(_pair?: Pair): number {
        if (this.priceHistory.length < 10) return 0;

        // Variância realizada por segundo: média de r²/dt sobre os retornos log.
        // Normalizar por dt torna a medida imune a amostragem irregular.
        let varianceRateSum = 0;
        let samples = 0;

        for (let i = 1; i < this.priceHistory.length; i++) {
            const prev = this.priceHistory[i - 1]!;
            const curr = this.priceHistory[i]!;
            const dtSeconds = (curr.ts - prev.ts) / 1000;
            if (dtSeconds <= 0 || prev.price <= 0 || curr.price <= 0) continue;

            const logReturn = Math.log(curr.price / prev.price);
            varianceRateSum += (logReturn * logReturn) / dtSeconds;
            samples++;
        }

        if (samples === 0) return 0;

        const variancePerSecond = varianceRateSum / samples;
        return Math.sqrt(variancePerSecond * this.HORIZON_SECONDS);
    }

    public shouldPause(pair: Pair): boolean {
        const volatilityPercentage = this.getVolatilityPercentage(pair);

        if (volatilityPercentage > this.THRESHOLD) {
            console.log(`⚠️ Volatility Monitor Veto: Volatility at ${(volatilityPercentage * 100).toFixed(4)}% (Limit: ${(this.THRESHOLD * 100).toFixed(4)}%)`);
            return true;
        }

        return false;
    }
}
