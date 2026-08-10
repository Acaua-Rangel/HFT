import { PriceIngestor } from "../domain/interfaces/PriceIngestor";
import { Pair } from "../domain/valueObjects/Pair";
import { Tick } from "../domain/valueObjects/Tick";
import { Amount } from "../domain/valueObjects/Amount";
import { HistoricalTickData } from "./BinanceHistoricalDownloader";
import { TimeProvider } from "./TimeProvider";

/**
 * Reconstrói um book sintético a partir de klines históricas.
 *
 * A versão anterior usava spread fixo de 0,01% e profundidade 1, com a quantidade de cada
 * nível igual ao volume inteiro da barra. Medindo o BTCFDUSD real: o spread fica em ~1 tick
 * (0,0000155% a 64.500), ou seja o book sintético era ~645× mais largo que o verdadeiro, e
 * a profundidade por nível gira em torno de algumas centenas de FDUSD, não o volume da
 * barra toda. Com o book errado, as condições de execução do simulador não têm relação com
 * a realidade.
 */
export class HistoricalPriceIngestor implements PriceIngestor {
    private callbacks: ((tick: Tick) => void)[] = [];
    private tradeCallbacks: ((symbol: string, volume: number) => void)[] = [];
    private subscriptions: Map<string, Pair> = new Map();

    /** Tick size do símbolo. O spread do book real é tipicamente 1 tick em pares líquidos. */
    private tickSize = 0.01;
    /** Notional típico descansando em cada nível do topo do book, na moeda quote. */
    private levelDepthQuote = 500;
    /** Quantos níveis sintetizar (LiquidityMonitor inspeciona os 3 primeiros). */
    private readonly LEVELS = 3;

    public configureBook(params: { tickSize?: number; levelDepthQuote?: number }): void {
        if (params.tickSize !== undefined && params.tickSize > 0) this.tickSize = params.tickSize;
        if (params.levelDepthQuote !== undefined && params.levelDepthQuote > 0) this.levelDepthQuote = params.levelDepthQuote;
    }

    public subscribe(pair: Pair): void {
        pair.applyBinanceSymbol((symbol: string) => {
            this.subscriptions.set(symbol.toUpperCase(), pair);
        });
    }

    public onTick(callback: (tick: Tick) => void): void {
        this.callbacks.push(callback);
    }

    public onTrade(callback: (symbol: string, volume: number) => void): void {
        this.tradeCallbacks.push(callback);
    }

    public emitHistoricalTick(data: HistoricalTickData): void {
        for (const [symbol, pair] of this.subscriptions.entries()) {
            TimeProvider.setVirtualTime(data.timestamp);

            this.tradeCallbacks.forEach(cb => cb(symbol, data.volume));

            // Book centrado no close, com meio-spread de meio tick — reproduz um book de
            // 1 tick de largura, que é o que o BTCFDUSD real apresenta.
            const halfSpread = this.tickSize / 2;
            const bids: { price: Amount, qty: Amount }[] = [];
            const asks: { price: Amount, qty: Amount }[] = [];

            for (let i = 0; i < this.LEVELS; i++) {
                const bidPrice = data.price - halfSpread - (i * this.tickSize);
                const askPrice = data.price + halfSpread + (i * this.tickSize);
                if (bidPrice <= 0) break;
                // Profundidade cresce ao se afastar do topo, como num book real.
                const depthQuote = this.levelDepthQuote * (1 + i);
                bids.push({ price: new Amount(bidPrice), qty: new Amount(depthQuote / bidPrice) });
                asks.push({ price: new Amount(askPrice), qty: new Amount(depthQuote / askPrice) });
            }

            const tick = new Tick(pair, asks, bids);
            this.callbacks.forEach(cb => cb(tick));
        }
    }
}
