import { BinanceAutoScanner } from "./src/infrastructure/BinanceAutoScanner";

async function run() {
	const scanner = new BinanceAutoScanner();
	const res = await scanner.scanTriangles("USDT", "BRL");
	console.log("Total triangles found:", res.length);
	const _coins = res.map((t) => {
		let b = "";
		t.pairTuple.first.applyCurrencies((_base: any, quote: any) =>
			quote.applySymbol((s: any) => (b = s)),
		);
		return b;
	});
}
run();
