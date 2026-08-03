import { BinanceAutoScanner } from "./src/infrastructure/BinanceAutoScanner";

async function run() {
  const scanner = new BinanceAutoScanner();
  const res = await scanner.scanTriangles("USDT", "BRL");
  console.log("Total triangles found:", res.length);
  const coins = res.map(t => {
      let b = "";
      t.first.applyCurrencies((base) => base.applySymbol(s => b = s));
      return b;
  });
  console.log("Coins:", coins.join(", "));
}
run();
