import { Currency } from "./src/domain/valueObjects/Currency";
import { Pair } from "./src/domain/valueObjects/Pair";
import { BinancePriceIngestor } from "./src/infrastructure/BinancePriceIngestor";

const btcBrl = new Pair(new Currency("BTC"), new Currency("BRL"));
const ingestor = new BinancePriceIngestor();

ingestor.onTick((tick) => {
	console.log("Got tick:", tick);
	process.exit(0);
});

ingestor.subscribe(btcBrl);

setTimeout(() => console.log("Timeout"), 3000);
