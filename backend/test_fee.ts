import { BinanceFeeFetcher } from "./src/infrastructure/BinanceFeeFetcher";
import { Pair } from "./src/domain/valueObjects/Pair";
import { Currency } from "./src/domain/valueObjects/Currency";

const f = new BinanceFeeFetcher();
console.log(f.getFeeFor(new Pair(new Currency("BTC"), new Currency("BRL"))));
