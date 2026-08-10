import { Pair } from "../../domain/valueObjects/Pair";
import { OrderExecutor, ActiveOrder } from "../../domain/interfaces/OrderExecutor";
import { Amount } from "../../domain/valueObjects/Amount";
import { LocalStateManager } from "../LocalStateManager";
import { CircuitBreaker } from "./CircuitBreaker";
import { InventoryManager, QuoteVeto } from "./InventoryManager";
import { BinanceUserDataStream, ExecutionReport } from "../../infrastructure/BinanceUserDataStream";
import { TimeProvider } from "../../infrastructure/TimeProvider";

export class MarketMakerCycle {
    public lotConfig: { mode: "PERCENTAGE" | "FIXED", value: number } = { mode: "PERCENTAGE", value: 0.05 };
    
    public currentEffectiveBuyLotQuote: number = 0;
    public currentEffectiveSellLotQuote: number = 0;

    public activeBuyOrders: (ActiveOrder | null)[] = [];
    public activeSellOrders: (ActiveOrder | null)[] = [];
    
    public hangingBuyOrders: ActiveOrder[] = [];
    public hangingSellOrders: ActiveOrder[] = [];

    // Reposicionar uma ordem custa prioridade de fila: a ordem nova volta para o fim
    // da fila. Cancelar de forma agressiva significa que a única maneira de ser
    // executado é o preço atravessar a ordem — ou seja, apenas quando estamos errados.
    // Estes três parâmetros seguem a semântica do Hummingbot (order_refresh_time,
    // max_order_age, order_refresh_tolerance_pct).
    private readonly ORDER_REFRESH_TIME_MS = 30000; // intervalo mínimo entre reposicionamentos
    private readonly MAX_ORDER_AGE_MS = 60000;      // idade máxima absoluta de uma ordem
    private readonly MIN_TOLERANCE_PCT = 0.0005;    // piso da tolerância de desvio de preço
    private lastRefreshAt = 0;

    /**
     * Após um fill, esperamos antes de recotar aquele lado (Hummingbot: filled_order_delay,
     * default 60s). Substitui o antigo ping-pong, que disparava automaticamente uma ordem
     * oposta a 0,1% do preço de execução. O ping-pong nunca foi validado com dados e
     * competia com o ciclo normal de cotação: como suas ordens ficavam mais perto do mid
     * que as principais, capturavam preferencialmente o fluxo.
     */
    private readonly FILLED_ORDER_DELAY_MS = 60000;
    private buyBlockedUntil = 0;
    private sellBlockedUntil = 0;

    /**
     * Milissegundos restantes de cooldown pós-fill por lado (0 se não bloqueado).
     * Existe para a telemetria: sem isso, um lado que simplesmente está esperando o
     * filled_order_delay passar é indistinguível, no dashboard, de um lado travado por
     * saldo insuficiente — os dois aparentam "não está cotando".
     */
    public getCooldownRemainingMs(): { buy: number; sell: number } {
        const now = TimeProvider.now();
        return {
            buy: Math.max(0, this.buyBlockedUntil - now),
            sell: Math.max(0, this.sellBlockedUntil - now),
        };
    }

    // Id sentinela do lock otimista: a ordem foi reservada localmente mas ainda não existe
    // na exchange. Nunca pode ser enviada para cancelOrder — a Binance exige orderId
    // numérico e rejeita com -1100 ("Illegal characters found in parameter 'orderId'").
    private static readonly PENDING_ORDER_ID = "__PENDING__";

    // Hanging orders não são reavaliadas pelo ciclo de refresh; sem expiração elas
    // acumulam indefinidamente e seguem descontando saldo disponível.
    private readonly HANGING_MAX_AGE_MS = 600000;   // 10 minutos
    private readonly HANGING_MAX_DRIFT_PCT = 0.01;  // 1% de distância do mid

    /**
     * Liquidar estoque a mercado quando a tendência de queda passa do limiar.
     *
     * NASCE DESLIGADO de propósito. A ordem a mercado é taker, e o `zeroFeePromoBases` do
     * index.ts assume taxa zero sem nunca ter verificado se a promo do BTCFDUSD vale para
     * taker ou só para maker. Se for maker-only, cada flatten custa ~10 bps e disparar
     * algumas vezes por dia dreni mais do que a perda que evita.
     *
     * Ligar só depois de medir a comissão realizada de taker com scripts/binance-audit.ts.
     * O flatten do kill switch é outra história e continua sempre ativo: é raro,
     * existencial, e o custo de taker é irrelevante frente a segurar a posição às cegas.
     */
    public TREND_FLATTEN_ENABLED = false;
    private readonly TREND_FLATTEN_COOLDOWN_MS = 300000; // 5 min entre liquidações
    private lastFlattenAt = 0;

    public currentPair: Pair | null = null;

    constructor(
        private stateManager: LocalStateManager,
        private circuitBreaker: CircuitBreaker,
        private inventoryManager: InventoryManager,
        public executor: OrderExecutor,
        private userDataStream?: BinanceUserDataStream
    ) {
        if (this.userDataStream) {
            this.userDataStream.onOrderFilled(this.handleOrderFilled.bind(this));
            this.userDataStream.onOrderCanceled(this.handleOrderCanceled.bind(this));
        }
    }

    private async handleOrderFilled(report: ExecutionReport): Promise<void> {
        const matches = (o: ActiveOrder | null | undefined): boolean =>
            !!o && (o.orderId === report.clientOrderId || o.orderId === report.orderId.toString());

        for (let i = 0; i < this.activeBuyOrders.length; i++) {
            if (matches(this.activeBuyOrders[i])) this.activeBuyOrders[i] = null;
        }
        for (let i = 0; i < this.activeSellOrders.length; i++) {
            if (matches(this.activeSellOrders[i])) this.activeSellOrders[i] = null;
        }
        this.hangingBuyOrders = this.hangingBuyOrders.filter(o => !matches(o));
        this.hangingSellOrders = this.hangingSellOrders.filter(o => !matches(o));

        // O lado vem do relatório da exchange, que é autoritativo. A versão anterior
        // inferia o lado a partir de qual array continha a ordem e caía num default
        // `isBuy = true` quando não achava nenhuma — o que era o caso comum, já que o
        // lock otimista fica com um id que nunca casa. O efeito era disparar a perna
        // oposta na direção errada.
        const now = TimeProvider.now();
        if (report.side === "BUY") {
            this.buyBlockedUntil = now + this.FILLED_ORDER_DELAY_MS;
        } else if (report.side === "SELL") {
            this.sellBlockedUntil = now + this.FILLED_ORDER_DELAY_MS;
        }
    }

    /** True quando a ordem existe de fato na exchange e pode ser cancelada. */
    private isCancelable(order: ActiveOrder | null | undefined): order is ActiveOrder {
        return !!order && order.orderId !== MarketMakerCycle.PENDING_ORDER_ID;
    }

    /**
     * Cancela uma ordem rastreada. Locks otimistas são apenas descartados: eles nunca
     * chegaram à exchange, então cancelá-los produz erro de parâmetro e nada mais.
     */
    private async cancelTracked(order: ActiveOrder): Promise<void> {
        if (!this.isCancelable(order)) return;
        try {
            await this.executor.cancelOrder(order);
        } catch {
            // Falha de cancelamento não pode derrubar o ciclo; o refresh tenta de novo.
        }
    }

    /** Cancela e limpa todas as ordens ativas rastreadas (usado pelo kill switch). */
    public async cancelAllActiveOrders(): Promise<void> {
        const pending: Promise<void>[] = [];
        for (let i = 0; i < this.activeBuyOrders.length; i++) {
            const o = this.activeBuyOrders[i];
            this.activeBuyOrders[i] = null;
            if (o) pending.push(this.cancelTracked(o));
        }
        for (let i = 0; i < this.activeSellOrders.length; i++) {
            const o = this.activeSellOrders[i];
            this.activeSellOrders[i] = null;
            if (o) pending.push(this.cancelTracked(o));
        }
        await Promise.all(pending);
    }

    /**
     * Cancela absolutamente tudo, inclusive as hanging orders.
     *
     * `cancelAllActiveOrders` ignora os arrays de hanging — o que basta para o refresh, mas
     * não para liquidar: uma venda a mercado precisa do BTC livre, e BTC preso numa hanging
     * order faz a Binance rejeitar com -2010.
     */
    private async cancelEverything(): Promise<void> {
        const hanging = [...this.hangingBuyOrders, ...this.hangingSellOrders];
        this.hangingBuyOrders = [];
        this.hangingSellOrders = [];
        await Promise.all([
            this.cancelAllActiveOrders(),
            ...hanging.map(o => this.cancelTracked(o)),
        ]);
    }

    /**
     * Liquida o estoque excedente a mercado até `targetBasePct` do patrimônio.
     *
     * Existe porque o mecanismo passivo não consegue sair de uma posição numa queda: a
     * ordem de venda só executa se o preço subir até ela, exatamente o que não acontece
     * quando o preço está caindo. Sem isto, o "stop loss" apenas congelava a perda —
     * cancelava as ordens, parava o motor, e deixava o BTC exposto sem ninguém gerindo.
     *
     * SOMENTE VENDA, por decisão de projeto. Se estivermos ABAIXO do alvo, não faz nada:
     * quem chama isto é o kill switch de drawdown ou a defesa de tendência de queda, e
     * comprar BTC no exato momento em que concluímos que não entendemos o mercado seria
     * aumentar risco sob o nome de "rebalancear". Um mecanismo de defesa só encolhe
     * exposição.
     *
     * É taker: paga o spread e, se a promo de taxa zero for maker-only, paga taxa também.
     * Deve ser raro. Ver TREND_FLATTEN_COOLDOWN_MS.
     */
    public async flattenInventory(
        pair: Pair,
        midPrice: number,
        minNotional: number,
        targetBasePct: number
    ): Promise<void> {
        if (midPrice <= 0) return;

        await this.cancelEverything();

        const baseValue = this.inventoryManager.baseBalance * midPrice;
        const totalWealth = baseValue + this.inventoryManager.quoteBalance;
        if (totalWealth <= 0) return;

        const excessQuote = baseValue - (totalWealth * targetBasePct);
        if (excessQuote < minNotional) {
            // Ou já estamos no alvo, ou o excedente é poeira que a exchange rejeitaria.
            return;
        }

        // Nunca pedir mais base do que temos: erro de arredondamento aqui vira -2010.
        const qtyToSell = Math.min(excessQuote / midPrice, this.inventoryManager.baseBalance);
        if (qtyToSell <= 0) return;

        console.log(`🛟 [FLATTEN] Liquidando ${qtyToSell.toFixed(8)} base (~${(qtyToSell * midPrice).toFixed(2)} quote) para voltar a ${(targetBasePct * 100).toFixed(0)}% de estoque.`);

        try {
            const fill = await this.executor.executeMarketSell(pair, new Amount(qtyToSell));
            fill.apply((qty, quote, avgPrice, success) => {
                if (!success) {
                    this.executor.logError("FLATTEN_FAILED", `Venda a mercado de ${qtyToSell} não preencheu.`);
                    return;
                }
                let q = 0, qt = 0, p = 0;
                qty.apply(v => q = v);
                quote.apply(v => qt = v);
                avgPrice.apply(v => p = v);
                console.log(`✅ [FLATTEN] Vendido ${q} @ ${p.toFixed(2)} = ${qt.toFixed(2)} quote.`);
            });
        } catch (err) {
            this.executor.logError("FLATTEN_EXCEPTION", err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * Expira hanging orders por idade ou por distância do preço atual. Sem isso elas só
     * saem do array quando executam — e enquanto ficam, seu notional é descontado do
     * saldo disponível, o que estrangula a cotação dos níveis principais.
     */
    private async reapHangingOrders(midPrice: number): Promise<void> {
        const now = TimeProvider.now();
        const expired: ActiveOrder[] = [];

        const keep = (o: ActiveOrder): boolean => {
            const tooOld = now - o.timestamp > this.HANGING_MAX_AGE_MS;
            const drifted = midPrice > 0
                && Math.abs(o.price - midPrice) / midPrice > this.HANGING_MAX_DRIFT_PCT;
            if (tooOld || drifted) { expired.push(o); return false; }
            return true;
        };

        this.hangingBuyOrders = this.hangingBuyOrders.filter(keep);
        this.hangingSellOrders = this.hangingSellOrders.filter(keep);

        if (expired.length) {
            await Promise.all(expired.map(o => this.cancelTracked(o)));
        }
    }

    private async handleOrderCanceled(report: ExecutionReport): Promise<void> {
        for (let i = 0; i < this.activeBuyOrders.length; i++) {
            if (this.activeBuyOrders[i]?.orderId === report.clientOrderId || this.activeBuyOrders[i]?.orderId === report.orderId.toString()) {
                this.activeBuyOrders[i] = null;
            }
        }
        for (let i = 0; i < this.activeSellOrders.length; i++) {
            if (this.activeSellOrders[i]?.orderId === report.clientOrderId || this.activeSellOrders[i]?.orderId === report.orderId.toString()) {
                this.activeSellOrders[i] = null;
            }
        }
        this.hangingBuyOrders = this.hangingBuyOrders.filter(o => o.orderId !== report.clientOrderId && o.orderId !== report.orderId.toString());
        this.hangingSellOrders = this.hangingSellOrders.filter(o => o.orderId !== report.clientOrderId && o.orderId !== report.orderId.toString());
    }

    public async executeTick(
        pair: Pair,
        feeRate: number = 0.001,
        volatilityPct: number = 0,
        isZeroFee: boolean = false,
        k: number = 1.5,
        minNotional: number = 10,
        trendSignal: number = 0,
        trendThreshold: number = 0.004,
        trendFlattenThreshold: number = 0.010
    ): Promise<void> {
        this.currentPair = pair;

        const levels = this.inventoryManager.ORDER_LEVELS;

        // Ensure arrays match InventoryManager levels
        while (this.activeBuyOrders.length < levels) this.activeBuyOrders.push(null);
        while (this.activeSellOrders.length < levels) this.activeSellOrders.push(null);

        // Se ORDER_LEVELS diminuiu em runtime, os níveis excedentes ficariam órfãos:
        // nunca mais seriam avaliados, mas seguiriam descontando saldo. Cancela e descarta.
        if (this.activeBuyOrders.length > levels || this.activeSellOrders.length > levels) {
            const orphans = [
                ...this.activeBuyOrders.slice(levels),
                ...this.activeSellOrders.slice(levels),
            ].filter((o): o is ActiveOrder => o !== null);
            this.activeBuyOrders.length = levels;
            this.activeSellOrders.length = levels;
            await Promise.all(orphans.map(o => this.cancelTracked(o)));
        }

        if (this.circuitBreaker.shouldPause(pair)) {
            await this.cancelAllActiveOrders();
            return;
        }

        const book = this.stateManager.retrieveOrderBook(pair);
        if (!book) return;
        const tick = book.getLatest();
        if (!tick) return;

        const midPriceAmount = tick.getMidPrice();
        if (!midPriceAmount) return;

        let midPrice = 0;
        midPriceAmount.apply(v => midPrice = v);
        if (midPrice <= 0) return;

        let bestBid = 0;
        let bestAsk = 0;
        tick.applyTopBid(l => { if (l) l.price.apply(v => bestBid = v); });
        tick.applyTopAsk(l => { if (l) l.price.apply(v => bestAsk = v); });

        // Defesa de tendência: numa queda forte, o lado vendedor passivo não sai da posição
        // (o preço se afasta das nossas asks em vez de vir até elas). A única saída é
        // agredir o book. Acontece antes de cotar porque cotar com estoque que já decidimos
        // liquidar só travaria o saldo de novo.
        const nowTs = TimeProvider.now();
        if (this.TREND_FLATTEN_ENABLED
            && trendSignal < -trendFlattenThreshold
            && nowTs - this.lastFlattenAt >= this.TREND_FLATTEN_COOLDOWN_MS) {
            this.lastFlattenAt = nowTs;
            console.log(`📉 [TREND] Queda de ${(trendSignal * 100).toFixed(3)}% na janela — liquidando excedente até o alvo.`);
            await this.flattenInventory(pair, midPrice, minNotional, this.inventoryManager.INVENTORY_TARGET_BASE_PCT);
        }

        let { bids, asks, bidEnabled, askEnabled, bidVeto, askVeto, effectiveSpread } =
            this.inventoryManager.getQuotes(midPrice, feeRate, volatilityPct, isZeroFee, bestBid, bestAsk, k, trendSignal, trendThreshold);

        // Invariante: nenhum lado pode parar de cotar em silêncio. Um lado desligado por
        // tendência é indistinguível, no dashboard, de um travado por saldo — e estoque
        // derivando sem ninguém perceber foi o que produziu "pico short = 0" na auditoria.
        if (bidVeto) this.logSideVeto("BUY", bidVeto, trendSignal);
        if (askVeto) this.logSideVeto("SELL", askVeto, trendSignal);

        // Enforce Post-Only limits for the tightest level (Level 0)
        // If the tightest level crosses, we adjust all levels relative to it
        if (bids.length > 0 && bestAsk > 0 && bids[0]!.price >= bestAsk) {
            const shift = bids[0]!.price - (bestAsk * 0.99999);
            bids.forEach(b => b.price -= shift);
        }
        if (asks.length > 0 && bestBid > 0 && asks[0]!.price <= bestBid) {
            const shift = (bestBid * 1.00001) - asks[0]!.price;
            asks.forEach(a => a.price += shift);
        }

        const totalWealth = (this.inventoryManager.baseBalance * midPrice) + this.inventoryManager.quoteBalance;
        const MAX_ORDER_VALUE = totalWealth * 0.60;
        const MIN_ORDER_VALUE = minNotional;

        if (MAX_ORDER_VALUE < MIN_ORDER_VALUE) {
            this.logStuck(`CAPITAL INSUFICIENTE: patrimônio ${totalWealth.toFixed(2)} permite no máximo ${MAX_ORDER_VALUE.toFixed(2)} por ordem, mas o mínimo da exchange é ${MIN_ORDER_VALUE.toFixed(2)}. Nenhuma cotação é possível.`);
            return;
        }

        let baseLotQuote = this.lotConfig.mode === "PERCENTAGE"
            ? totalWealth * this.lotConfig.value
            : this.lotConfig.value;

        // Skew de estoque sobre o TAMANHO (modelo do Hummingbot), aplicado ANTES do piso
        // de notional mínimo. A ordem inversa (piso antes do skew) fazia o skew empurrar
        // o lote de volta para baixo do mínimo, bloqueando o nível — e como o skew só
        // encolhe o lado comprador quando estamos long, o lado da compra morria em
        // silêncio enquanto o da venda seguia ativo, produzindo deriva de estoque.
        const { bidRatio, askRatio } = this.inventoryManager.getInventorySkewRatios(midPrice, baseLotQuote);
        let buyLotQuote = baseLotQuote * bidRatio;
        let sellLotQuote = baseLotQuote * askRatio;

        // O notional mínimo é uma restrição rígida da corretora, não uma preferência de
        // risco: se o skew pedir menos que o mínimo, postamos o mínimo para manter os
        // dois lados cotados. O corte de risco de verdade continua sendo o
        // bidEnabled/askEnabled do InventoryManager (MAX_INVENTORY_SKEW).
        buyLotQuote = Math.min(Math.max(buyLotQuote, MIN_ORDER_VALUE), MAX_ORDER_VALUE);
        sellLotQuote = Math.min(Math.max(sellLotQuote, MIN_ORDER_VALUE), MAX_ORDER_VALUE);

        this.currentEffectiveBuyLotQuote = buyLotQuote;
        this.currentEffectiveSellLotQuote = sellLotQuote;

        // --- Decisão de reposicionamento (semântica do Hummingbot) ---
        // Só cancelamos quando alguma ordem estourou a idade máxima, ou quando o preço
        // saiu da tolerância E já passou o intervalo mínimo de refresh. Fora disso as
        // ordens ficam paradas acumulando prioridade de fila.
        const now = TimeProvider.now();
        const tolerancePct = Math.max(this.MIN_TOLERANCE_PCT, effectiveSpread * 0.5);

        let priceDrifted = false;
        let ageExceeded = false;
        for (let i = 0; i < levels; i++) {
            const b = this.activeBuyOrders[i];
            if (b) {
                if (Math.abs(b.price - bids[i]!.price) / bids[i]!.price > tolerancePct) priceDrifted = true;
                if (now - b.timestamp > this.MAX_ORDER_AGE_MS) ageExceeded = true;
            }
            const s = this.activeSellOrders[i];
            if (s) {
                if (Math.abs(s.price - asks[i]!.price) / asks[i]!.price > tolerancePct) priceDrifted = true;
                if (now - s.timestamp > this.MAX_ORDER_AGE_MS) ageExceeded = true;
            }
        }

        const refreshWindowOpen = now - this.lastRefreshAt >= this.ORDER_REFRESH_TIME_MS;
        if (ageExceeded || (priceDrifted && refreshWindowOpen)) {
            this.lastRefreshAt = now;
            const cancels: Promise<void>[] = [];
            for (let i = 0; i < levels; i++) {
                const b = this.activeBuyOrders[i];
                this.activeBuyOrders[i] = null;
                if (b) cancels.push(this.cancelTracked(b));
                const s = this.activeSellOrders[i];
                this.activeSellOrders[i] = null;
                if (s) cancels.push(this.cancelTracked(s));
            }
            // Em paralelo: serializados, 2×ORDER_LEVELS round-trips cabiam mal no ciclo.
            await Promise.all(cancels);
        }

        await this.reapHangingOrders(midPrice);

        const promises: Promise<void>[] = [];

        for (let i = 0; i < levels; i++) {
            const targetBid = bids[i]!.price;
            const targetAsk = asks[i]!.price;
            const buyLevelQuote = buyLotQuote * bids[i]!.amountFactor;
            const sellLevelBase = (sellLotQuote * asks[i]!.amountFactor) / midPrice;

            // Cancelamentos já foram resolvidos em bloco acima; aqui só preenchemos
            // os níveis vazios (ordem executada, cancelada ou ainda não colocada).
            // Recalculado a cada nível porque os níveis anteriores já reservaram saldo.
            // O clamp evita que estado rastreado divergente da exchange produza um
            // "disponível" negativo e trave a cotação para sempre.
            let lockedQuote = 0;
            for (const o of this.activeBuyOrders) {
                if (o) lockedQuote += (o.qty * o.price);
            }
            for (const o of this.hangingBuyOrders) {
                if (o) lockedQuote += (o.qty * o.price);
            }
            lockedQuote = Math.min(lockedQuote, this.inventoryManager.quoteBalance);

            let lockedBase = 0;
            for (const o of this.activeSellOrders) {
                if (o) lockedBase += o.qty;
            }
            for (const o of this.hangingSellOrders) {
                if (o) lockedBase += o.qty;
            }
            lockedBase = Math.min(lockedBase, this.inventoryManager.baseBalance);

            if (!this.activeBuyOrders[i] && bidEnabled && targetBid > 0 && now >= this.buyBlockedUntil) {
                let finalBuyLevelQuote = buyLevelQuote;
                if (buyLevelQuote + lockedQuote > this.inventoryManager.quoteBalance) {
                    finalBuyLevelQuote = this.inventoryManager.quoteBalance - lockedQuote;
                }
                
                const meetsMin = finalBuyLevelQuote >= MIN_ORDER_VALUE;
                
                if (meetsMin) {
                    const quoteToSpend = new Amount(finalBuyLevelQuote);
                    // Lock otimista: reserva o saldo para os próximos níveis desta mesma
                    // passada. O .catch é essencial — sem ele uma exceção na colocação
                    // deixa o lock preso para sempre, descontando saldo de um pedido que
                    // nunca existiu e sendo enviado a cancelOrder com um id inválido.
                    this.activeBuyOrders[i] = { orderId: MarketMakerCycle.PENDING_ORDER_ID, symbol: "", side: "BUY", price: targetBid, qty: finalBuyLevelQuote / targetBid, timestamp: TimeProvider.now() };
                    promises.push(
                        this.executor.executeMakerBuy(pair, quoteToSpend, new Amount(targetBid))
                        .then(order => { this.activeBuyOrders[i] = order ?? null; })
                        .catch(err => {
                            this.activeBuyOrders[i] = null;
                            this.executor.logError("ORDER_PLACE_EXCEPTION", `BUY L${i}: ${err instanceof Error ? err.message : String(err)}`);
                        })
                    );
                } else if (i === 0 && finalBuyLevelQuote < MIN_ORDER_VALUE) {
                    this.logStuck(`BUY L${i} BLOCKED: Insufficient Balance. Required: ${MIN_ORDER_VALUE.toFixed(2)} | Free(Available): ${finalBuyLevelQuote.toFixed(2)}`);
                }
            }

            if (!this.activeSellOrders[i] && askEnabled && targetAsk > 0 && now >= this.sellBlockedUntil) {
                let finalSellLevelBase = sellLevelBase;
                if (sellLevelBase + lockedBase > this.inventoryManager.baseBalance) {
                    finalSellLevelBase = this.inventoryManager.baseBalance - lockedBase;
                }
                
                const meetsMin = (finalSellLevelBase * midPrice) >= MIN_ORDER_VALUE;
                
                if (meetsMin) {
                    const baseToSell = new Amount(finalSellLevelBase);
                    this.activeSellOrders[i] = { orderId: MarketMakerCycle.PENDING_ORDER_ID, symbol: "", side: "SELL", price: targetAsk, qty: finalSellLevelBase, timestamp: TimeProvider.now() };
                    promises.push(
                        this.executor.executeMakerSell(pair, baseToSell, new Amount(targetAsk))
                        .then(order => { this.activeSellOrders[i] = order ?? null; })
                        .catch(err => {
                            this.activeSellOrders[i] = null;
                            this.executor.logError("ORDER_PLACE_EXCEPTION", `SELL L${i}: ${err instanceof Error ? err.message : String(err)}`);
                        })
                    );
                } else if (i === 0 && !meetsMin) {
                    this.logStuck(`SELL L${i} BLOCKED: Insufficient Balance. Required: ${MIN_ORDER_VALUE.toFixed(2)} | Free(Available): ${(finalSellLevelBase * midPrice).toFixed(2)}`);
                }
            }
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    /**
     * Throttle próprio, separado do `logStuck`. Se compartilhassem o contador, um lado
     * travado por saldo silenciaria o aviso de veto por tendência do outro lado durante um
     * minuto inteiro — que é exatamente o silêncio que a invariante proíbe.
     */
    private lastVetoLog: Record<string, number> = {};
    private logSideVeto(side: "BUY" | "SELL", veto: QuoteVeto, trendSignal: number): void {
        if (!veto) return;
        const key = `${side}:${veto}`;
        const now = TimeProvider.now();
        if (now - (this.lastVetoLog[key] ?? 0) < 60000) return;
        this.lastVetoLog[key] = now;

        const detail = veto === "TREND"
            ? ` (tendência ${(trendSignal * 100).toFixed(3)}% na janela)`
            : "";
        const message = `${side} SIDE OFF: ${veto}${detail}`;
        console.log(`\n🚦 [DIAGNOSTIC] ${message}`);
        try {
            this.executor.logError("DIAGNOSTIC_SIDE_VETO", message);
        } catch (err) {}
    }

    private lastStuckLog = 0;
    private logStuck(message: string) {
        const now = TimeProvider.now();
        if (now - this.lastStuckLog > 60000) { // Log once per minute max
            console.log(`\n🛑 [DIAGNOSTIC] ${message}`);
            
            // Also log to the error_logs table so it shows up in diagnostic scripts
            try {
                this.executor.logError("DIAGNOSTIC_STUCK", message);
            } catch (err) {}
            
            this.lastStuckLog = now;
        }
    }
}
