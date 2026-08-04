async function run() {
  console.log("Fetching Binance exchange info...");
  const res = await fetch("https://api.binance.com/api/v3/exchangeInfo");
  const data: any = await res.json();
  
  const symbols = data.symbols.filter((s: any) => s.status === "TRADING");
  const pairs = new Set(symbols.map((s: any) => s.symbol));
  
  // We want triangles: BRL -> X -> Y -> BRL
  // Or BRL -> X -> USDT -> BRL
  const baseCurrency = "BRL";
  const intermediateQuotes = ["USDT", "BTC", "ETH", "BNB", "FDUSD"];
  
  let validTriangles = [];

  for (const sym of symbols) {
    if (sym.quoteAsset === baseCurrency) {
      const asset = sym.baseAsset;
      
      // Now find if asset trades against any of the intermediateQuotes
      for (const quote of intermediateQuotes) {
        if (asset === quote) continue;
        
        // Asset -> Quote (e.g. PEPEUSDT)
        const assetQuotePair1 = asset + quote;
        const assetQuotePair2 = quote + asset;
        
        let foundIntermediate = false;
        let intermediatePair = "";
        
        if (pairs.has(assetQuotePair1)) {
          foundIntermediate = true;
          intermediatePair = assetQuotePair1;
        } else if (pairs.has(assetQuotePair2)) {
          foundIntermediate = true;
          intermediatePair = assetQuotePair2;
        }
        
        if (foundIntermediate) {
          // Quote -> BRL (e.g. USDTBRL)
          const quoteBrlPair1 = quote + baseCurrency;
          const quoteBrlPair2 = baseCurrency + quote;
          
          if (pairs.has(quoteBrlPair1)) {
            validTriangles.push({
              leg1: sym.symbol, // BRL -> Asset
              leg2: intermediatePair, // Asset -> Quote
              leg3: quoteBrlPair1, // Quote -> BRL
              asset,
              quote
            });
          } else if (pairs.has(quoteBrlPair2)) {
            validTriangles.push({
              leg1: sym.symbol,
              leg2: intermediatePair,
              leg3: quoteBrlPair2,
              asset,
              quote
            });
          }
        }
      }
    }
  }
  
  console.log(`Found ${validTriangles.length} valid triangular paths starting with BRL.`);
  
  // Let's filter for "obscure" (meme coins, low cap, etc)
  // We'll just list some known volatile/meme assets
  const obscureAssets = ["PEPE", "SHIB", "DOGE", "BONK", "FLOKI", "WIF", "MEME", "BOME", "NOT", "PEOPLE"];
  
  const obscureTriangles = validTriangles.filter(t => obscureAssets.includes(t.asset));
  
  console.log("\nObscure Triangles:");
  obscureTriangles.forEach(t => console.log(`${t.leg1} -> ${t.leg2} -> ${t.leg3} (${t.asset}/${t.quote})`));
}

run();
