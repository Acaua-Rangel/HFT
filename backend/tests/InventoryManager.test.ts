import { describe, expect, it } from "bun:test";
import { InventoryManager } from "../src/application/mm/InventoryManager";

describe("InventoryManager", () => {
    it("should disable quoting if total wealth is zero", () => {
        const im = new InventoryManager();
        im.baseBalance = 0;
        im.quoteBalance = 0;
        
        const quotes = im.getQuotes(100);
        expect(quotes.bidEnabled).toBeFalse();
        expect(quotes.askEnabled).toBeFalse();
    });

    it("should generate symmetric quotes when inventory is perfectly balanced", () => {
        const im = new InventoryManager();
        im.baseBalance = 0.5;
        im.quoteBalance = 50; 
        
        const quotes = im.getQuotes(100);
        expect(quotes.q).toBe(0);
        expect(quotes.bidEnabled).toBeTrue();
        expect(quotes.askEnabled).toBeTrue();
        expect(quotes.bids[0].price).toBeLessThan(100);
        expect(quotes.asks[0].price).toBeGreaterThan(100);
    });

    // Regressão: uma versão anterior do termo de Avellaneda convertia sigma para unidades
    // absolutas de preço (sigma_abs = sigma_pct * midPrice). Isso introduz um fator
    // midPrice extra no termo gamma*sigma², que em ativos caros (BTC ~64.500) faz o spread
    // explodir — a 0,5% de volatilidade medido, ~16%. gamma e k aqui são escalares
    // heurísticos (slider da UI / TradeIntensityMonitor), nunca calibrados para a escala
    // de preço de um ativo específico, então não podem ser usados como os parâmetros
    // físicos do paper original.
    it("should keep the spread sane at BTC-scale prices across the gamma/k range, even at elevated volatility", () => {
        const midPrice = 64500;
        const volatilityLevels = [0.0001, 0.001, 0.003, 0.005]; // até 0.5%, o limiar de pausa
        const gammaLevels = [0.05, 0.1, 0.5, 1.0];
        const kLevels = [5, 15, 30];

        for (const vol of volatilityLevels) {
            for (const gamma of gammaLevels) {
                for (const kVal of kLevels) {
                    const im = new InventoryManager();
                    im.GAMMA = gamma;
                    im.baseBalance = 0.5;
                    im.quoteBalance = 32000;

                    const quotes = im.getQuotes(midPrice, 0.001, vol, false, midPrice - 5, midPrice + 5, kVal);

                    // Nunca deve passar muito além do maior piso de segurança (5x vol);
                    // se passar, o termo de Avellaneda está dominando de forma patológica.
                    expect(quotes.effectiveSpread).toBeLessThan(Math.max(0.01, vol * 6));
                }
            }
        }
    });

    // O inventário atua sobre o TAMANHO das ordens, não sobre o preço. O skew de preço
    // anterior deslocava a reserva em ~1e-4% — efetivamente nada.

    it("should shrink the buy lot and grow the sell lot when long on base asset", () => {
        const im = new InventoryManager();
        im.baseBalance = 1;      // 100 em valor
        im.quoteBalance = 20;    // total 120, alvo 60 → comprado bem acima do alvo

        const { bidRatio, askRatio } = im.getInventorySkewRatios(100, 10);

        expect(im.getQuotes(100, 0, 0.002).q).toBeGreaterThan(0);
        expect(bidRatio).toBeLessThan(1);
        expect(askRatio).toBeGreaterThan(1);
        expect(bidRatio + askRatio).toBeCloseTo(2, 10);
    });

    it("should grow the buy lot and shrink the sell lot when short on base asset", () => {
        const im = new InventoryManager();
        im.baseBalance = 0.2;    // 20 em valor
        im.quoteBalance = 100;   // total 120, alvo 60 → abaixo do alvo

        const { bidRatio, askRatio } = im.getInventorySkewRatios(100, 10);

        expect(im.getQuotes(100, 0, 0.002).q).toBeLessThan(0);
        expect(bidRatio).toBeGreaterThan(1);
        expect(askRatio).toBeLessThan(1);
        expect(bidRatio + askRatio).toBeCloseTo(2, 10);
    });

    it("should be neutral when inventory sits exactly on target", () => {
        const im = new InventoryManager();
        im.baseBalance = 0.5;
        im.quoteBalance = 50;

        const { bidRatio, askRatio } = im.getInventorySkewRatios(100, 10);

        expect(bidRatio).toBeCloseTo(1, 10);
        expect(askRatio).toBeCloseTo(1, 10);
    });

    it("should saturate the ratios between 0 and 2, never going negative", () => {
        const allBase = new InventoryManager();
        allBase.baseBalance = 10;
        allBase.quoteBalance = 0;
        const long = allBase.getInventorySkewRatios(100, 1);
        expect(long.bidRatio).toBeGreaterThanOrEqual(0);
        expect(long.bidRatio).toBeLessThanOrEqual(2);
        expect(long.askRatio).toBeLessThanOrEqual(2);

        const allQuote = new InventoryManager();
        allQuote.baseBalance = 0;
        allQuote.quoteBalance = 1000;
        const short = allQuote.getInventorySkewRatios(100, 1);
        expect(short.bidRatio).toBeLessThanOrEqual(2);
        expect(short.askRatio).toBeGreaterThanOrEqual(0);
    });

    it("should quote symmetrically around mid, since inventory no longer shifts price", () => {
        const im = new InventoryManager();
        im.baseBalance = 1;
        im.quoteBalance = 20;

        const quotes = im.getQuotes(100, 0, 0.002);
        expect(quotes.reservationPrice).toBe(100);

        const bidGap = 100 - quotes.bids[0]!.price;
        const askGap = quotes.asks[0]!.price - 100;
        expect(bidGap).toBeCloseTo(askGap, 10);
    });

    it("should disable bid if inventory skew exceeds max", () => {
        const im = new InventoryManager();
        im.baseBalance = 100; 
        im.quoteBalance = 1; 
        
        const quotes = im.getQuotes(100);
        expect(quotes.q).toBeGreaterThan(im.MAX_INVENTORY_SKEW);
        expect(quotes.bidEnabled).toBeFalse();
        expect(quotes.askEnabled).toBeTrue();
    });

    it("should adjust effective spread based on fee and volatility", () => {
        const im = new InventoryManager();
        im.baseBalance = 0.5;
        im.quoteBalance = 50; 
        
        const normalQuotes = im.getQuotes(100, 0.001, 0.001); 
        const highVolQuotes = im.getQuotes(100, 0.001, 0.005); 
        
        expect(highVolQuotes.effectiveSpread).toBeGreaterThan(normalQuotes.effectiveSpread);
    });
});
