import { Currency } from "./src/domain/valueObjects/Currency";
import { Pair } from "./src/domain/valueObjects/Pair";
import { BinanceFeeFetcher } from "./src/infrastructure/BinanceFeeFetcher";

const f = new BinanceFeeFetcher();
console.log(f.getFeeFor(new Pair(new Currency("BTC"), new Currency("BRL"))));
