import { Currency } from "../domain/valueObjects/Currency";
import { Pair } from "../domain/valueObjects/Pair";
import { TriangularPairs } from "./TriangularPairs";
import { PairTuple } from "./TriangularPairs";

export class BinanceAutoScanner {
  public async scanTriangles(baseQuoteStr = "USDT", finalQuoteStr = "BRL"): Promise<TriangularPairs[]> {
    const triangles: TriangularPairs[] = [];
    try {
      const response = await fetch("https://api.binance.com/api/v3/exchangeInfo");
      if (!response.ok) {
        console.warn(`⚠️ Failed to scan exchangeInfo: HTTP ${response.status}`);
        return triangles;
      }
      
      const data: any = await response.json();

      // Busca todos os preços atuais para o filtro de Stablecoins
      const priceResp = await fetch("https://api.binance.com/api/v3/ticker/price");
      let priceMap = new Map<string, number>();
      if (priceResp.ok) {
        const priceData: any = await priceResp.json();
        for (const item of priceData) {
          priceMap.set(item.symbol, parseFloat(item.price));
        }
      }
      
      // Armazena as moedas base que pareiam com USDT e as que pareiam com BRL
      const usdtBases = new Set<string>();
      const brlBases = new Set<string>();

      for (const item of data.symbols) {
        if (item.status === "TRADING") {
          if (item.quoteAsset === baseQuoteStr) {
            usdtBases.add(item.baseAsset);
          } else if (item.quoteAsset === finalQuoteStr) {
            brlBases.add(item.baseAsset);
          }
        }
      }

      const brlCurrency = new Currency(finalQuoteStr);
      const usdtCurrency = new Currency(baseQuoteStr);

      for (const baseStr of brlBases) {
        // Ignora caso a base seja USDT (não queremos USDT/USDT/BRL)
        if (baseStr === baseQuoteStr) continue;

        // Se a moeda faz par com BRL E também faz par com USDT
        if (usdtBases.has(baseStr)) {
          const usdtSymbol = `${baseStr}${baseQuoteStr}`; // ex: USDCUSDT
          const priceUsdt = priceMap.get(usdtSymbol);

          // Filtro Dinâmico Anti-Stablecoin (Ignora se o valor for ~ 1.00 USD)
          if (priceUsdt !== undefined && priceUsdt >= 0.95 && priceUsdt <= 1.05) {
            console.log(`🚫 AutoScanner: Banned Stablecoin ${baseStr} (Dynamic Peg Detection - Price: ${priceUsdt})`);
            continue;
          }

          const baseAsset = new Currency(baseStr);
          
          // Leg 1: Compra USDT com BRL
          const quoteBrl = new Pair(usdtCurrency, brlCurrency);
          // Leg 2: Compra Moeda com USDT
          const baseQuote = new Pair(baseAsset, usdtCurrency);
          // Leg 3: Vende Moeda por BRL
          const baseBrl = new Pair(baseAsset, brlCurrency);

          const tuple = new PairTuple(quoteBrl, baseQuote);
          const triangle = new TriangularPairs(tuple, baseBrl);
          
          triangles.push(triangle);
        }
      }

      console.log(`📡 AutoScanner: Found ${triangles.length} active triangular arbitrage routes for ${baseQuoteStr} -> ${finalQuoteStr}.`);

    } catch (e) {
      console.warn("⚠️ Error during AutoScanner", e);
    }
    return triangles;
  }
}
