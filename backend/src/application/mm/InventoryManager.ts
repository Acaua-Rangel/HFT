export interface InventorySkewRatios {
    /** Multiplicador do lote de compra, 0..2. Cai a 0 quando estamos comprados demais. */
    bidRatio: number;
    /** Multiplicador do lote de venda, 0..2. Complementar: sempre 2 - bidRatio. */
    askRatio: number;
}

/**
 * Por que um lado parou de cotar. `null` = está cotando.
 *
 * Existe para a invariante "nenhum lado morre em silêncio": antes, `bidEnabled = false`
 * chegava no MarketMakerCycle sem nenhuma pista da causa, e um lado desligado por estoque
 * era indistinguível de um desligado por saldo. Estoque derivando em silêncio foi o que
 * produziu "pico short = 0" na auditoria.
 */
export type QuoteVeto = "NO_WEALTH" | "INVENTORY_SKEW" | "TREND" | null;

export class InventoryManager {
    /**
     * Fração do patrimônio mantida no ativo base.
     *
     * NÃO é 0.5 (o "neutro" do market maker de livro-texto). Este bot opera spot, sem
     * instrumento de short: cada satoshi em estoque é exposição direcional pura, que rende
     * apenas o spread capturado e perde o movimento inteiro do BTC quando o preço cai.
     * 0.5 significava manter metade do patrimônio apostado na direção do BTC 24h por dia —
     * a captura de spread de 0,05% por round-trip não paga uma queda de 2%.
     *
     * 0.25 é o limite de exposição direcional que aceitamos para conseguir cotar os dois
     * lados. O número certo depende de quanto o spread realmente captura; enquanto o
     * markout não for medido (ver auditoria), este é um teto de risco, não uma otimização.
     */
    public INVENTORY_TARGET_BASE_PCT = 0.25;

    /**
     * Largura da faixa de inventário, em múltiplos do lote, dentro da qual o skew de
     * tamanho interpola. Faixa estreita = reação agressiva a desvios pequenos.
     */
    public INVENTORY_RANGE_MULTIPLIER = 4.0;

    // Pausa total de um lado quando o desvio de inventário passa disto (q em ±0.5).
    // 0.30 (era 0.40) — corta o lado comprador mais cedo. É o corte de risco de verdade;
    // o piso de notional mínimo nunca deve ser usado para isso.
    public MAX_INVENTORY_SKEW = 0.30;

    // Quantas vezes a volatilidade medida o spread precisa cobrir.
    public SAFETY_MULTIPLIER = 5.0;
    // Piso absoluto, para mercados parados.
    public ABSOLUTE_MIN_SPREAD = 0.0005;
    // Spread base configurável pelo dashboard.
    public BASE_SPREAD_PCT = 0.001;

    // GAMMA segue exposto para o dashboard e para o termo de spread do Avellaneda.
    public GAMMA = 0.1;

    public baseBalance: number = 0;
    public quoteBalance: number = 0;

    // Um nível por lado. Ver comentário em ORDER_LEVELS antes de aumentar.
    // 3 níveis com fatores 1/1.5/2 exigem 4.5× o lote base por lado; com capital pequeno
    // cada nível cai abaixo do notional mínimo da exchange e o lado inteiro é bloqueado.
    public ORDER_LEVELS = 1;
    public LEVEL_SPREAD_STEP = 0.0005;
    public LEVEL_AMOUNT_FACTOR = 0.5;

    constructor() {}

    /**
     * Skew de inventário sobre o TAMANHO das ordens, no modelo do Hummingbot
     * (`inventory_skew_calculator.pyx`).
     *
     * A versão anterior tentava enviesar o PREÇO via reservation price, mas com
     * GAMMA=0.1, q máximo de 0.5 e volatilidade na casa de 0.1%, o deslocamento era da
     * ordem de 1e-4% — literalmente nada. O controle de estoque não existia na prática, e
     * a auditoria confirmou: o bot nunca voltou a flat, pico short = 0.
     *
     * Aqui o inventário atua onde tem efeito real: comprado demais ⇒ compra menos e vende
     * mais, até zerar o lado comprador nos extremos.
     */
    public getInventorySkewRatios(midPrice: number, lotQuote: number): InventorySkewRatios {
        const baseValue = this.baseBalance * midPrice;
        const totalValue = baseValue + this.quoteBalance;

        if (totalValue <= 0 || lotQuote <= 0 || midPrice <= 0) {
            return { bidRatio: 1, askRatio: 1 };
        }

        const targetValue = totalValue * this.INVENTORY_TARGET_BASE_PCT;
        // A faixa nunca passa de metade do patrimônio, senão os limites saem do domínio.
        const rangeValue = Math.min(this.INVENTORY_RANGE_MULTIPLIER * lotQuote, totalValue * 0.5);

        if (rangeValue <= 0) return { bidRatio: 1, askRatio: 1 };

        const leftLimit = Math.max(targetValue - rangeValue, 0);
        const rightLimit = targetValue + rangeValue;

        let bidRatio: number;
        if (baseValue < targetValue) {
            // Abaixo do alvo: interpola de 2.0 (sem base nenhuma) até 1.0 (no alvo).
            const t = this.interp(baseValue, leftLimit, targetValue, 0, 0.5);
            bidRatio = this.interp(t, 0, 0.5, 2.0, 1.0);
        } else {
            // Acima do alvo: de 1.0 (no alvo) até 0.0 (comprado no limite da faixa).
            const t = this.interp(baseValue, targetValue, rightLimit, 0.5, 1.0);
            bidRatio = this.interp(t, 0.5, 1.0, 1.0, 0.0);
        }

        return { bidRatio, askRatio: 2.0 - bidRatio };
    }

    /** Interpolação linear com saturação nas pontas (equivalente a np.interp). */
    private interp(x: number, x0: number, x1: number, y0: number, y1: number): number {
        if (x1 <= x0) return y0;
        if (x <= x0) return y0;
        if (x >= x1) return y1;
        return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }

    /**
     * Preços de cotação.
     *
     * O spread é o máximo entre:
     *   - o termo de Avellaneda-Stoikov (gamma·sigma²·T + (2/gamma)·ln(1+gamma/k))
     *   - piso de taxa: 2 × feeRate × 1.5, cobrindo o round-trip com margem
     *   - piso de volatilidade: SAFETY_MULTIPLIER × sigma
     *   - piso absoluto e o BASE_SPREAD_PCT do dashboard
     *
     * O preço de reserva é o mid puro: o inventário é tratado por
     * `getInventorySkewRatios`, não deslocando preço.
     */
    public getQuotes(
        midPrice: number,
        feeRate: number = 0.001,
        volatilityPct: number = 0,
        isZeroFee: boolean = false,
        bestBid: number = 0,
        bestAsk: number = 0,
        k: number = 1.5,
        trendSignal: number = 0,
        trendThreshold: number = 0.004
    ): {
        bids: { price: number, amountFactor: number }[],
        asks: { price: number, amountFactor: number }[],
        bidEnabled: boolean, askEnabled: boolean,
        bidVeto: QuoteVeto, askVeto: QuoteVeto,
        q: number, reservationPrice: number, effectiveSpread: number, minSpreadFloor: number,
        bidDistancePct: number, askDistancePct: number, bidDistanceAbs: number, askDistanceAbs: number
    } {
        const baseWealth = this.baseBalance * midPrice;
        const totalWealth = baseWealth + this.quoteBalance;

        let q = 0;
        let bidVeto: QuoteVeto = null;
        let askVeto: QuoteVeto = null;

        if (totalWealth <= 0) {
            bidVeto = "NO_WEALTH";
            askVeto = "NO_WEALTH";
        } else {
            const baseRatio = baseWealth / totalWealth;
            q = baseRatio - this.INVENTORY_TARGET_BASE_PCT;

            if (q > this.MAX_INVENTORY_SKEW) bidVeto = "INVENTORY_SKEW";
            if (q < -this.MAX_INVENTORY_SKEW) askVeto = "INVENTORY_SKEW";
        }

        // Veto de tendência — segunda fonte, independente do estoque.
        //
        // Deliberadamente ASSIMÉTRICO: veta a compra numa queda, mas NÃO veta a venda numa
        // alta. A simetria seria a escolha óbvia e está errada aqui. O risco estrutural
        // deste bot é estar comprado: ele opera spot, o alvo de estoque é positivo, e o
        // modo de falha documentado é acumular BTC e vê-lo depreciar. Qualquer mecanismo
        // que suprima a VENDA amplifica exatamente esse modo de falha.
        //
        // Vender numa alta "deixa dinheiro na mesa" — e tudo bem. O trabalho de um market
        // maker é capturar spread, não acertar direção; segurar estoque esperando a alta
        // continuar é apostar direcional com outro nome, e é a aposta que já custou caro.
        if (trendSignal < -trendThreshold && bidVeto === null) {
            bidVeto = "TREND";
        }

        const bidEnabled = bidVeto === null;
        const askEnabled = askVeto === null;

        // Spread de Avellaneda-Stoikov:  delta = gamma·sigma²·T + (2/gamma)·ln(1 + gamma/k)
        //
        // No paper esta fórmula é em unidades absolutas de preço, e uma tentativa anterior
        // de converter para essas unidades (sigma_abs = sigma_pct · midPrice) foi revertida:
        // ela introduz um fator midPrice extra no primeiro termo (gamma·sigma_abs²/midPrice
        // = gamma·sigma_pct²·midPrice), que para BTC (~64.500) faz o spread explodir — a
        // 0,5% de volatilidade, medido, o spread ia a 16%. GAMMA e k aqui são escalares
        // heurísticos ajustados por slider/monitor de intensidade, nunca calibrados para a
        // escala de preço de um ativo específico; usá-los como se fossem os parâmetros
        // físicos do paper (que têm unidades de 1/(preço·quantidade) e 1/preço) não faz
        // sentido dimensional em nenhuma das duas formas.
        //
        // Por isso a fórmula roda inteira em espaço fracionário (sigma como fração do
        // preço, resultado como fração do preço) — a mesma abordagem que já era usada
        // antes destas mudanças e que a auditoria com dados reais confirmou produzir
        // spreads na faixa de 0,1%–0,3%, dominados pelos pisos de segurança abaixo.
        //
        // Nessas unidades, gamma·sigma²·T é sempre desprezível (sigma~0,1–0,5% ⇒ termo
        // ~1e-6..1e-5) — não é bug, é o comportamento esperado do AS em baixa volatilidade.
        // O termo (2/gamma)·ln(1+gamma/k) fica em torno de 0,36–0,40 (36–40%) para
        // gamma∈[0,05, 1] e k=5 (o mínimo do TradeIntensityMonitor), e cai conforme k
        // sobe — k alto (mercado ativo) deveria mesmo apertar o spread, essa é a intenção.
        // AS_HEURISTIC_SCALE traz esse termo para a mesma ordem de grandeza dos pisos, de
        // modo que GAMMA e k possam empurrar o spread sem dominar sozinhos a decisão.
        const AS_HEURISTIC_SCALE = 0.001;

        const sigma = Math.max(volatilityPct, 0);
        const timeHorizon = 1.0; // sigma já vem escalado para o horizonte de exposição
        const safeGamma = Math.max(this.GAMMA, 0.01);
        const safeK = Math.max(k, 0.01);

        const avellanedaSpreadPct = Math.max(0,
            (safeGamma * sigma * sigma * timeHorizon) +
            (2 / safeGamma) * Math.log(1 + safeGamma / safeK) * AS_HEURISTIC_SCALE
        );

        const feeFloor = feeRate > 0 ? 2 * feeRate * 1.5 : 0;
        const volatilityFloor = this.SAFETY_MULTIPLIER * sigma;
        const minSpreadFloor = Math.max(feeFloor, volatilityFloor, this.ABSOLUTE_MIN_SPREAD, this.BASE_SPREAD_PCT);

        const effectiveSpread = Math.max(avellanedaSpreadPct, minSpreadFloor);
        const baseHalfSpread = effectiveSpread / 2;

        const reservationPrice = midPrice;

        const bids: { price: number, amountFactor: number }[] = [];
        const asks: { price: number, amountFactor: number }[] = [];

        for (let i = 0; i < this.ORDER_LEVELS; i++) {
            const levelSpreadAdd = i * this.LEVEL_SPREAD_STEP;
            const amountFactor = 1 + (i * this.LEVEL_AMOUNT_FACTOR);
            bids.push({ price: reservationPrice * (1 - baseHalfSpread - levelSpreadAdd), amountFactor });
            asks.push({ price: reservationPrice * (1 + baseHalfSpread + levelSpreadAdd), amountFactor });
        }

        let bidDistancePct = 0;
        let askDistancePct = 0;
        let bidDistanceAbs = 0;
        let askDistanceAbs = 0;

        if (bestBid > 0 && bids.length > 0) {
            bidDistancePct = (bestBid - bids[0]!.price) / bestBid * 100;
            bidDistanceAbs = bestBid - bids[0]!.price;
        }
        if (bestAsk > 0 && asks.length > 0) {
            askDistancePct = (asks[0]!.price - bestAsk) / bestAsk * 100;
            askDistanceAbs = asks[0]!.price - bestAsk;
        }

        return { bids, asks, bidEnabled, askEnabled, bidVeto, askVeto, q, reservationPrice, effectiveSpread, minSpreadFloor, bidDistancePct, askDistancePct, bidDistanceAbs, askDistanceAbs };
    }
}
