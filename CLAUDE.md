# HFT — Market Maker para Binance Spot

Bot de market making (Avellaneda-Stoikov simplificado) para Binance Spot, com dashboard web.
Par configurado atualmente: **BTCFDUSD**, em `backend/index.ts`.

## Layout

```
backend/          Bun + TypeScript. É onde vive o motor.
  index.ts        Composition root: wiring, loop principal, WS server (porta 3000), backtest
  src/domain/     Value objects (Amount, Pair, Tick, Money) e interfaces. Sem I/O.
  src/application/
    mm/           O motor de market making — MarketMakerCycle, InventoryManager,
                  CircuitBreaker, RiskManager, VolatilityMonitor, LiquidityMonitor,
                  TradeIntensityMonitor
    LocalStateManager.ts, ExecutionLock.ts
  src/infrastructure/
                  Binance* (REST/WS/execução), Simulation* (backtest), database/ (sqlite)
  scripts/        Ferramentas de diagnóstico (binance-audit.ts)
  tests/          Bun test
frontend/         React + Vite. Dashboard que fala com o WS do backend.
scratch/hummingbot/   Implementação de referência (Python/Cython). Não é código do projeto.
docs/             Relatórios de auditoria e decisões
```

Os value objects usam um estilo *applicative* incomum: em vez de getters, expõem
`apply(cb)` / `applySymbol(cb)` / `applyCurrencies(cb)`. Siga esse padrão ao mexer no domínio.

## Comandos

```bash
cd backend
bun run index.ts          # sobe o motor + WS na porta 3000
bun test                  # suíte completa
bun run scripts/binance-audit.ts --days=7    # auditoria de performance real

cd frontend && npm run dev
```

Credenciais em `backend/.env`: `BINANCE_API_KEY`, `BINANCE_API_SECRET`. Bun carrega o `.env`
automaticamente. **Nunca imprima as chaves** — para verificar presença, cheque `.length`.

## Modos de operação

`BACKTEST` (default seguro) e `LIVE`, alternados via mensagem WS `TOGGLE_MODE`. O
`MarketMakerCycle` recebe um `OrderExecutor` que é trocado entre `SimulationOrderExecutor` e
`BinanceOrderExecutor`. `TimeProvider` abstrai o relógio para permitir tempo virtual no
backtest — **use `TimeProvider.now()`, nunca `Date.now()`**, em qualquer código que rode
dentro do ciclo.

## Regras de domínio que não são óbvias no código

Estas vieram de uma auditoria com dados reais (ver `docs/2026-08-10-auditoria-lucratividade.md`).
Violar qualquer uma delas destrói a lucratividade de forma silenciosa.

1. **Cancelar ordem custa prioridade de fila.** Uma ordem reposicionada volta para o fim da
   fila. Se as ordens vivem poucos segundos, a única forma de serem executadas é o preço
   atravessá-las — ou seja, você só é preenchido quando está errado. Isso já aconteceu neste
   projeto: 99.340 ordens para 31 fills, vida útil mediana de 1 segundo, edge de −6 bps com
   taxa zero. Qualquer mudança que reduza `MAX_ORDER_AGE_MS` ou `ORDER_REFRESH_TIME_MS`
   precisa de justificativa forte e validação com dados reais.

2. **O spread cotado precisa cobrir o custo de round-trip.** `2 × feeRate`. Hoje o BTCFDUSD
   tem promo de taxa zero e isso está hardcoded em `index.ts` (`zeroFeePromoBases`). Se a
   promo acabar, o bot passa a cotar abaixo do custo sem nenhum alarme.

3. **Notional mínimo é restrição rígida da exchange, não preferência de risco.** Aplique o
   skew de estoque **antes** do piso de notional. A ordem inversa faz o skew empurrar o lote
   de volta para baixo do mínimo, bloqueando o nível — e como o skew só encolhe o lado
   comprador quando se está long, o lado da compra morre em silêncio e o estoque deriva.
   O corte de risco de verdade é `bidEnabled`/`askEnabled` via `MAX_INVENTORY_SKEW`.

4. **Um market maker precisa fechar o ciclo em segundos.** Se o intervalo entre uma compra e
   a venda seguinte é de minutos, o PnL é dominado por movimento direcional, não por captura
   de spread. Medido neste projeto: p50 de 23 minutos.

5. **Nenhum lado pode morrer em silêncio.** Se um lado deixa de cotar por qualquer motivo que
   não seja o kill switch explícito, o estoque deriva estruturalmente. Sempre logue.

## Armadilhas conhecidas

- **O backtest superestima o fill rate em ~1.700×** (1.433 fills/h simulados vs 0,86 reais).
  `SimulationOrderExecutor` usa uma fila rasa demais e `HistoricalPriceIngestor` sintetiza um
  book de profundidade 1 com spread fixo de 0,005%. **Não use o backtest como juiz de
  lucratividade** até ele ser recalibrado. Use `scripts/binance-audit.ts`.
- **`backend/hft.sqlite` não é fonte da verdade.** Contém dados de simulação e pode estar
  desatualizado em relação à VM. Para performance real, sempre a API da Binance.
- **`VolatilityMonitor.getVolatilityPercentage()` muta estado** (empurra amostra no histórico)
  e é chamado 2–3× por loop. Além disso mede dispersão do nível de preço, não de retornos.
- **Avellaneda-Stoikov em `InventoryManager` é efetivamente código morto** — os termos são
  ~1e-7 e sempre sobrepostos pelos pisos no `Math.max`. O spread real é
  `max(feeFloor, 5×vol, 0.0005, BASE_SPREAD_PCT)`.
- **Hanging orders não têm reaper.** Nada as cancela; só saem por fill.

## Referência: Hummingbot

`scratch/hummingbot/` tem a implementação de referência da comunidade. Ao mudar qualquer
mecanismo de quoting, confira como o Hummingbot resolve antes de inventar. Arquivos úteis:

- `hummingbot/strategy/pure_market_making/pure_market_making.pyx` — estratégia principal;
  `c_cancel_active_orders` (semântica de tolerância), `c_did_complete_buy_order`
  (`filled_order_delay`)
- `.../pure_market_making_config_map.py` — defaults: `order_refresh_time` 30s,
  `max_order_age` 1800s, `filled_order_delay` 60s, `order_levels` 1
- `.../inventory_skew_calculator.pyx` — skew sobre tamanhos (0 a 2×)
- `hummingbot/strategy/hanging_orders_tracker.py` — ciclo de vida de hanging orders

## Convenções

- Comentários em português, em prosa, explicando **por quê** — não o quê. Veja
  `MarketMakerCycle.ts` para o tom.
- Não adicione dependências sem necessidade real. O backend hoje tem uma só (`glob`).
- Mudanças em parâmetros de quoting: rode `bun test` e registre o racional no commit.
