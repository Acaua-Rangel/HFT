import { BinancePriceIngestor } from "../src/infrastructure/BinancePriceIngestor";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Tick } from "../src/domain/valueObjects/Tick";

const ingestor = new BinancePriceIngestor();

const pairs = [
  new Pair(new Currency("BTC"), new Currency("BRL")),
  new Pair(new Currency("ETH"), new Currency("BTC")),
  new Pair(new Currency("ETH"), new Currency("BRL")),
  new Pair(new Currency("PEPE"), new Currency("USDT")),
  new Pair(new Currency("PEPE"), new Currency("BRL")),
  new Pair(new Currency("SHIB"), new Currency("USDT")),
  new Pair(new Currency("SHIB"), new Currency("BRL")),
  new Pair(new Currency("DOGE"), new Currency("USDT")),
  new Pair(new Currency("DOGE"), new Currency("BRL")),
  new Pair(new Currency("USDT"), new Currency("BRL"))
];

const counts: Record<string, number> = {};

setTimeout(() => {
  for (const p of pairs) {
    p.applyBinanceSymbol(s => counts[s] = 0);
    ingestor.subscribe(p);
  }
}, 2000);

ingestor.onTick((tick: Tick) => {
  tick.applyBinanceSymbol(sym => {
    counts[sym] = (counts[sym] || 0) + 1;
  });
});

setInterval(() => {
  console.log("Tick counts:", counts);
}, 2000);
