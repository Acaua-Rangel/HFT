import { LocalStateManager } from "../LocalStateManager";
import { Pair } from "../../domain/valueObjects/Pair";
import { TimeProvider } from "../../infrastructure/TimeProvider";

/**
 * Mede DIREÇÃO, não dispersão.
 *
 * O VolatilityMonitor responde "quanto o preço está se mexendo"; ele é cego para o sinal.
 * Uma queda limpa de 1% e uma alta limpa de 1% dão a mesma volatilidade, e é exatamente
 * essa cegueira que deixa o bot comprando durante uma queda: o skew de estoque encolhe o
 * lote de compra, mas comprar devagar durante uma queda ainda é comprar.
 *
 * Aqui o sinal é o retorno log acumulado da ponta mais antiga à mais nova da janela.
 * Negativo = tendência de queda. É deliberadamente uma medida burra: sem média móvel, sem
 * suavização, sem regressão. Em 5 minutos de BTC não há amostras suficientes para nada mais
 * sofisticado se sustentar, e um indicador complicado só esconderia o fato de que os
 * limiares abaixo ainda não foram calibrados com dados reais.
 *
 * Segue o contrato do VolatilityMonitor: `record()` amostra, o getter apenas lê. O getter
 * daquele monitor já mutou estado no passado e era chamado 2–3× por ciclo, fazendo a
 * estimativa depender de quantas vezes alguém tinha perguntado. Não repetir.
 */
export class TrendMonitor {
    /**
     * Janela de 5 minutos: precisa ser bem maior que os 60s do VolatilityMonitor, senão o
     * "sinal" é só ruído de microestrutura. Curta demais e o bot reage a cada oscilação;
     * longa demais e ele só percebe a queda depois de já ter comprado o caminho todo.
     */
    private readonly WINDOW_MS = 300000;

    /**
     * Abaixo de -TREND_THRESHOLD o lado comprador é vetado.
     *
     * ATENÇÃO: 0,4% em 5 minutos é um CHUTE INICIAL, não um número validado. Precisa ser
     * calibrado contra a distribuição real de retornos de 5min do BTCFDUSD — alto demais e
     * o veto nunca dispara, baixo demais e o bot para de comprar no ruído normal, o que
     * mata metade do market making sem motivo.
     */
    public TREND_THRESHOLD = 0.004;

    /**
     * Abaixo de -TREND_FLATTEN_THRESHOLD o estoque excedente é liquidado a mercado.
     * Muito mais alto que o veto porque a ação é cara: ordem a mercado paga o spread e
     * possivelmente taxa de taker. Também um chute inicial.
     */
    public TREND_FLATTEN_THRESHOLD = 0.010;

    /**
     * Mínimo de amostras para o sinal valer. Com o loop de 2s, 10 amostras são ~20s —
     * abaixo disso a janela ainda está enchendo e a ponta antiga não representa a janela.
     */
    private readonly MIN_SAMPLES = 10;

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
        if (last && last.ts === now) return;

        this.priceHistory.push({ ts: now, price: mid });

        const cutoff = now - this.WINDOW_MS;
        while (this.priceHistory.length && this.priceHistory[0]!.ts < cutoff) {
            this.priceHistory.shift();
        }
    }

    /**
     * Retorno log acumulado ao longo da janela, com sinal. -0.006 = o preço caiu 0,6%
     * da ponta antiga até agora. Puro: não altera estado.
     */
    public getTrendSignal(_pair?: Pair): number {
        if (this.priceHistory.length < this.MIN_SAMPLES) return 0;

        const oldest = this.priceHistory[0]!;
        const newest = this.priceHistory[this.priceHistory.length - 1]!;
        if (oldest.price <= 0 || newest.price <= 0) return 0;

        return Math.log(newest.price / oldest.price);
    }

    /** True quando o preço está caindo o suficiente para parar de comprar. */
    public isDowntrend(pair?: Pair): boolean {
        return this.getTrendSignal(pair) < -this.TREND_THRESHOLD;
    }

    /** True quando a queda é forte o suficiente para justificar liquidar a mercado. */
    public shouldFlatten(pair?: Pair): boolean {
        return this.getTrendSignal(pair) < -this.TREND_FLATTEN_THRESHOLD;
    }
}
