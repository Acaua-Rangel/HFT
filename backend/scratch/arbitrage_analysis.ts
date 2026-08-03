import { fetch } from "bun";

async function getPrices() {
  const res = await fetch("https://api.binance.com/api/v3/ticker/bookTicker");
  const data = await res.json();
  const map = new Map<string, { bidPrice: number, bidQty: number, askPrice: number, askQty: number }>();
  for (const item of data) {
    map.set(item.symbol, {
      bidPrice: parseFloat(item.bidPrice),
      bidQty: parseFloat(item.bidQty),
      askPrice: parseFloat(item.askPrice),
      askQty: parseFloat(item.askQty)
    });
  }
  return map;
}

async function analyze() {
  console.log("Coletando order book em tempo real da Binance...\n");
  const books = await getPrices();

  // Testaremos com algumas altcoins bem líquidas
  const testCoins = ["PEPE", "SHIB", "DOGE", "SOL"];
  const bnbDiscount = 0.00075; // 0.075% fee
  
  console.log("Comparação de Modelos de Arbitragem (Considerando Taxas com BNB Discount 0.075% por perna):");
  console.log("Taxa 3 pernas = 0.225% | Taxa 4 pernas = 0.300%\n");

  for (const alt of testCoins) {
    console.log(`\n=== Analisando Ativo: ${alt} ===`);

    try {
      // Pega os preços (A gente sempre "paga" o Ask pra comprar e "vende" no Bid pra receber)
      // Route 1 (Atual): BRL -> USDT -> ALT -> BRL
      const usdtBrl = books.get("USDTBRL"); // Comprar USDT usando BRL
      const altUsdt = books.get(`${alt}USDT`); // Comprar ALT usando USDT
      const altBrl = books.get(`${alt}BRL`); // Vender ALT por BRL
      
      let route1Profit = 0;
      if (usdtBrl && altUsdt && altBrl) {
        const bankBrl = 1000;
        const usdtGot = bankBrl / usdtBrl.askPrice;
        const altGot = usdtGot / altUsdt.askPrice;
        const brlGot = altGot * altBrl.bidPrice;
        
        const grossBrl = brlGot - bankBrl;
        const feesBrl = bankBrl * (3 * bnbDiscount);
        route1Profit = grossBrl - feesBrl;
        console.log(`[Opção 1] Rota 3-Pernas Base BRL (BRL->USDT->${alt}->BRL): Lucro de R$ ${route1Profit.toFixed(4)} (Bruto: R$ ${grossBrl.toFixed(4)})`);
      }

      // Route 2 (Proposta): USDT -> BTC -> ALT -> USDT
      const btcUsdt = books.get("BTCUSDT"); // Comprar BTC usando USDT
      const altBtc = books.get(`${alt}BTC`); // Comprar ALT usando BTC
      // Vender ALT por USDT -> já temos altUsdt.bidPrice
      
      let route2Profit = 0;
      if (btcUsdt && altBtc && altUsdt) {
        const bankUsdt = 200; // ~1000 BRL
        const btcGot = bankUsdt / btcUsdt.askPrice;
        const altGot = btcGot / altBtc.askPrice;
        const usdtGot = altGot * altUsdt.bidPrice;

        const grossUsdt = usdtGot - bankUsdt;
        const feesUsdt = bankUsdt * (3 * bnbDiscount);
        route2Profit = grossUsdt - feesUsdt;
        
        // Conversão visual apenas para comparar com BRL
        const route2ProfitInBrl = route2Profit * usdtBrl!.bidPrice;
        const grossUsdtInBrl = grossUsdt * usdtBrl!.bidPrice;

        console.log(`[Opção 2] Rota 3-Pernas Base USDT (USDT->BTC->${alt}->USDT): Lucro de R$ ${route2ProfitInBrl.toFixed(4)} (Bruto: R$ ${grossUsdtInBrl.toFixed(4)})`);
      }

      // Route 3 (4 Pernas): BRL -> USDT -> BTC -> ALT -> BRL
      // (Isso adicionaria a liquidez do dolar, mas adiciona 1 perna e taxa)
      let route3Profit = 0;
      if (usdtBrl && btcUsdt && altBtc && altBrl) {
        const bankBrl = 1000;
        const usdtGot = bankBrl / usdtBrl.askPrice;
        const btcGot = usdtGot / btcUsdt.askPrice;
        const altGot = btcGot / altBtc.askPrice;
        const brlGot = altGot * altBrl.bidPrice;

        const grossBrl = brlGot - bankBrl;
        const feesBrl = bankBrl * (4 * bnbDiscount);
        route3Profit = grossBrl - feesBrl;
        
        console.log(`[Opção 3] Rota 4-Pernas Base BRL (BRL->USDT->BTC->${alt}->BRL): Lucro de R$ ${route3Profit.toFixed(4)} (Bruto: R$ ${grossBrl.toFixed(4)})`);
      }
      // Route 4: USDT -> ALT -> BRL -> USDT
      let route4Profit = 0;
      if (usdtBrl && altUsdt && altBrl) {
        const bankUsdt = 200; // ~1000 BRL
        const altGot = bankUsdt / altUsdt.askPrice;
        const brlGot = altGot * altBrl.bidPrice;
        const usdtGot = brlGot / usdtBrl.askPrice;
        
        const grossUsdt = usdtGot - bankUsdt;
        const feesUsdt = bankUsdt * (3 * bnbDiscount);
        route4Profit = grossUsdt - feesUsdt;

        const route4ProfitInBrl = route4Profit * usdtBrl.bidPrice;
        const grossUsdtInBrl = grossUsdt * usdtBrl.bidPrice;

        console.log(`[Opção 4] Rota 3-Pernas Base USDT via BRL (USDT->${alt}->BRL->USDT): Lucro de R$ ${route4ProfitInBrl.toFixed(4)} (Bruto: R$ ${grossUsdtInBrl.toFixed(4)})`);
      }
    } catch(e) {
      console.log("Moeda sem pares suficientes na Binance");
    }
  }
}

analyze();
