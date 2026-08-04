import { BinanceFeeFetcher } from "./src/infrastructure/BinanceFeeFetcher";
import { BinancePriceIngestor } from "./src/infrastructure/BinancePriceIngestor";
import { Currency } from "./src/domain/valueObjects/Currency";
import { Pair } from "./src/domain/valueObjects/Pair";
import { Tick } from "./src/domain/valueObjects/Tick";

async function run() {
  console.log("📡 Iniciando Validação de Integração Binance...\n");
  
  const btc = new Currency("BTC");
  const brl = new Currency("BRL");
  const btcBrl = new Pair(btc, brl);

  // 1. Validação REST API (Taxas)
  console.log("--- 1. Testando BinanceFeeFetcher (REST API) ---");
  const feeFetcher = new BinanceFeeFetcher();
  try {
    const fee = await feeFetcher.getFeeFor(btcBrl);
    console.log(`✅ [SUCESSO] Taxa retornada pelo fetcher para o par BTCBRL. Valores internos:`, fee);
  } catch (error) {
    console.error(`❌ [ERRO INESPERADO] Falha no FeeFetcher:`, error);
  }

  // 2. Validação WebSocket API (Preços)
  console.log("\n--- 2. Testando BinancePriceIngestor (WebSocket) ---");
  const ingestor = new BinancePriceIngestor();
  let ticksReceived = 0;

  ingestor.onTick((tick: Tick) => {
    ticksReceived++;
    if (ticksReceived <= 3) {
      console.log(`✅ [SUCESSO WS] Tick recebido do mercado ao vivo:`, tick);
    }
    if (ticksReceived === 3) {
      console.log("\n🚀 Validação concluída. Recebemos as taxas e stream de preços. Encerrando script de teste...");
      process.exit(0);
    }
  });

  ingestor.subscribe(btcBrl);
  
  setTimeout(() => {
    if (ticksReceived === 0) {
      console.error("\n❌ [ERRO WS] Nenhum tick de preço recebido em 5 segundos. O WebSocket pode estar bloqueado.");
      process.exit(1);
    }
  }, 5000);
}

run();
