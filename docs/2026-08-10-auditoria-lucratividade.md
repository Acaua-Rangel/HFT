# Auditoria de lucratividade — 10/08/2026

Registro da sessão de análise do market maker. Contém o diagnóstico com dados reais da
Binance, o que foi implementado, e o que ainda falta.

---

## 1. Como o diagnóstico foi feito

### Tentativa descartada: `backend/hft.sqlite`

A primeira análise usou o sqlite local e chegou à conclusão errada. Aquele banco continha
**dados de simulação** (`status = "SIM_LIMIT_MAKER"`, par `BTCBRL`) e estava desatualizado.
O bot real roda **BTCFDUSD** numa VM.

**Lição:** o sqlite local não é fonte da verdade. A fonte da verdade é a Binance.

### Ferramenta criada: `backend/scripts/binance-audit.ts`

Script read-only que baixa da Binance e calcula as métricas que realmente diagnosticam
um market maker:

```bash
bun run scripts/binance-audit.ts --days=7 --markout-hours=48
bun run scripts/binance-audit.ts --days=2 --symbols=BTCFDUSD
```

Endpoints usados (todos de leitura): `/api/v3/account`, `/api/v3/myTrades`,
`/api/v3/allOrders`, `/api/v3/openOrders`, `/api/v3/klines`, `/api/v3/exchangeInfo`,
`/api/v3/ticker/price`.

Detalhes de implementação relevantes:
- Paginação por **bissecção temporal** — a Binance limita janelas a 24h e 1000 registros;
  quando a resposta vem cheia, o script divide a janela ao meio recursivamente.
- Descoberta automática de símbolos a partir dos saldos da conta.
- Comissões convertidas para o quote asset (trata comissão em BNB, base ou quote).
- Sincronização de relógio via `/api/v3/time` para evitar erro de `recvWindow`.

---

## 2. Os dados reais (BTCFDUSD, janela de 2 dias)

| Métrica | Valor |
|---|---|
| Ordens colocadas | **99.340** |
| Fills | **31** |
| Fill rate | **0,03%** (1 fill a cada ~3.200 ordens) |
| Canceladas sem nenhum fill | 99.309 (**100,0%**) |
| Vida útil das ordens | **p50 = 1,00s** · p90 = 4,01s · max = 65min |
| Taxas pagas | **0,0000 FDUSD (0,000 bps)** |
| Notional girado | 2.056,95 FDUSD |
| PnL líquido | **−1,2374 FDUSD** |
| **Edge bruto por notional** | **−6,016 bps** |
| Round-trip médio capturado | **−0,0151%** (mediana −0,0242%) |
| Intervalo entre pernas opostas | **p50 = 23 minutos** |
| Pico short | **0** — nunca voltou a flat |
| Maker / taker | 31 / 0 (100% maker) |

Saldos no momento da auditoria: `BTC = 0,00199202` (locked **0,00195000**, ou seja 98%),
`FDUSD = 35,74` (locked 0). Ordens abertas: **3 SELL, 0 BUY**.

---

## 3. Diagnóstico

### P1 — Perda com custo de transação zero ⇒ seleção adversa pura

`edge bruto = −6,016 bps` com `fee = 0 bps`. Não há taxa para culpar. A causa está medida:
**as ordens vivem 1 segundo (mediana)**.

Na fila do BTCFDUSD há milhares de ordens à frente. Em 1s não se avança na fila. A única
forma física de ser executado nesse intervalo é o preço vir até você — ou seja, o mercado
atravessar sua ordem. **Você só é preenchido quando está errado.** Os 99.309 cancelamentos
são as vezes em que você estava certo e desistiu antes de ganhar.

Causa no código (antes da correção): `TOLERANCE_PCT = 0.0005` e `MAX_ORDER_AGE_MS = 3000`
em `MarketMakerCycle.ts`, com loop de 2s em `index.ts`. O commit `bcc190c` havia reduzido a
idade máxima para 3s "for improved order responsiveness" — movimento contrário ao necessário.

Referência Hummingbot: `order_refresh_time = 30s`, `max_order_age = 1800s`, e
`order_refresh_tolerance_pct` que **adia** o cancelamento
(`pure_market_making.pyx`, `c_cancel_active_orders`).

### P2 — Round-trip de 23 minutos não é market making

`p50 = 1.378.677 ms` entre uma compra e a venda seguinte. O bot compra, fica 23 minutos com
exposição direcional ao BTC, e vende. O resultado é dominado pelo movimento do preço, não
pelo spread de 0,05% cotado. Spread realizado médio: **−0,0151%**.

### P3 — Lado da compra morria por ordem de operações errada

`MarketMakerCycle.ts` aplicava o piso `MIN_ORDER_VALUE` **antes** do skew de estoque:

```ts
baseLotQuote = Math.max(baseLotQuote, MIN_ORDER_VALUE);   // piso primeiro
let buyLotQuote = baseLotQuote * Math.max(0.2, 1 - q * 1.5);  // skew reduz depois
```

Com patrimônio de ~165 FDUSD: `165 × 0,05 = 8,23` → elevado a 10 → skew com `q = 0,28`
multiplica por 0,58 → **5,80** → abaixo do mínimo → nível bloqueado.

Como o skew só encolhe o lado comprador quando se está long, isso vira uma catraca: quanto
mais long, mais o lado da compra é bloqueado, mais long fica. `pico short = 0` confirma.

### P4 — 3 níveis inviáveis com 165 FDUSD

`ORDER_LEVELS = 3` com fatores 1/1,5/2 exige 4,5× o lote por lado. Para o nível 0 ter
10 FDUSD são 45 por lado, 90 comprometidos num patrimônio de 165 — e ainda com skew.
Os 3 sells abertos (0,00043 / 0,00065 / 0,00087 — razão exata 1 : 1,5 : 2) consumiam 100%
do BTC disponível.

### P5 — O backtest superestima o fill rate em ~1.700×

Simulador: 1.433 fills/hora. Realidade: **0,86 fills/hora**.

Causas:
- `SimulationOrderExecutor.ts` inicializa a fila em `max(3×qty, $10k/preço)` e drena a 15%
  do volume de cada tick — a fila real do topo de book é muito mais profunda.
- `HistoricalPriceIngestor.ts` sintetiza um book com spread fixo de 0,005% e profundidade 1,
  muito mais apertado que o real, fazendo o ramo de "crossing" disparar constantemente.
- Os dados são apenas o *close* de klines de 1s (sem high/low), então varreduras intrabar
  são invisíveis.

**Consequência:** parâmetros vinham sendo calibrados contra um simulador errado por três
ordens de grandeza.

### P6 — Razão ordem/trade de 3.200:1 é risco operacional

~50.000 ordens/dia. A Binance monitora `order/trade ratio` e aplica restrição de conta por
cancelamento excessivo.

### P7 — Taxa zero hardcoded, sem alarme

`index.ts` carrega uma lista fixa `zeroFeePromoBases`. **Hoje está correto** — a comissão
realizada foi 0,0000 FDUSD em 2.056,95 girados, a promo está ativa. Mas se a Binance
encerrar a promo, `feeFloor` continua 0, o bot segue cotando 0,1% de spread contra 0,2% de
custo real, e vira máquina de perda **sem nenhum sinal**.

### Achados secundários (não corrigidos)

- **Volatilidade medida errado** — `VolatilityMonitor.ts` calcula desvio-padrão do *nível de
  preço* sobre a média, não dos *retornos*. Em tendência isso explode mesmo sem ruído.
  Além disso `getVolatilityPercentage` **muta** o histórico a cada chamada e é chamada 2–3×
  por loop (main loop, circuit breaker, telemetria) — a estimativa depende de quantas vezes
  foi chamada.
- **Matemática de Avellaneda-Stoikov é código morto** — `InventoryManager.ts`:
  `variance = vol²` ≈ 1e-6, × GAMMA 0.1 = 1e-7, contribuição nula; o terceiro termo tem um
  `/1000` mágico. O resultado é sempre sobreposto pelo `Math.max` dos pisos.
- **Skew de preço é nulo** — `reservationPrice` desloca ~1e-4%. O inventário não influencia
  os preços na prática.
- **Hanging orders sem reaper** — nada cancela `hangingBuyOrders`/`hangingSellOrders`; elas
  só saem por fill. A ordem de vida máxima de 65min na auditoria confirma ordens presas.
- **`handleOrderFilled` assume `isBuy = true` por default** — se o relatório não casar com
  nenhuma ordem rastreada (provável, já que o placeholder otimista usa `orderId: "-1"`),
  dispara um ping-pong na direção errada.
- **Bloco morto** em `MarketMakerCycle.ts` — calcula um `shift` com a variável errada e
  descarta (o diagnóstico do TS marca `'shift' is declared but its value is never read`).

---

## 4. O que foi implementado

Commit `51597a7`. Quatro arquivos: `index.ts`, `scripts/binance-audit.ts`,
`InventoryManager.ts`, `MarketMakerCycle.ts`.

### ✅ Item 1 — Parar o churn

`MarketMakerCycle.ts`:

| Antes | Depois |
|---|---|
| `TOLERANCE_PCT = 0.0005` (fixo) | `MIN_TOLERANCE_PCT = 0.0005` como **piso**; tolerância efetiva = `max(piso, effectiveSpread × 0.5)` |
| `MAX_ORDER_AGE_MS = 3000` | `MAX_ORDER_AGE_MS = 60000` |
| — | `ORDER_REFRESH_TIME_MS = 30000` (novo gate temporal) |

Semântica adotada (do Hummingbot): decisão de reposicionamento tomada **uma vez para o
conjunto todo**, não por nível. Só cancela quando:
- alguma ordem estourou `MAX_ORDER_AGE_MS`, **ou**
- algum preço saiu da tolerância **E** já passou `ORDER_REFRESH_TIME_MS` desde o último
  reposicionamento.

Fora disso as ordens ficam paradas acumulando prioridade de fila. Níveis vazios (ordem
executada ou cancelada) continuam sendo preenchidos normalmente — preencher vazio não é churn.

Efeito colateral corrigido de graça: os cancelamentos agora rodam em `Promise.all` em vez de
serializados dentro do loop de níveis (antes eram até 2×`ORDER_LEVELS` round-trips em série).

Método `checkAndCancelOrder` removido (substituído pela decisão em bloco).

### ✅ Item 2 — `ORDER_LEVELS: 3 → 1`

`InventoryManager.ts`. Default do Hummingbot para pure market making também é 1.

Adicionado em `MarketMakerCycle.executeTick` um trecho que cancela e descarta níveis órfãos
caso `ORDER_LEVELS` diminua em runtime — sem isso os níveis excedentes nunca mais seriam
avaliados mas seguiriam descontando saldo.

### ✅ Item 3 — Ordem do `MIN_ORDER_VALUE` e notional real da exchange

- Skew de estoque aplicado **antes** do piso de notional.
- Piso e teto aplicados **por lado**, depois do skew.
- `MIN_ORDER_VALUE` agora vem de `precisionFetcher.getMinNotional(symbol)`, passado como novo
  parâmetro `minNotional` de `executeTick` (default 10 para compatibilidade). Ambos os call
  sites em `index.ts` (loop principal e backtest) foram atualizados.
- Guarda nova: se `MAX_ORDER_VALUE < MIN_ORDER_VALUE` (patrimônio pequeno demais), loga
  diagnóstico e retorna em vez de falhar em silêncio.

Princípio adotado: o notional mínimo é restrição rígida da corretora, não preferência de
risco. Se o skew pedir menos que o mínimo, posta-se o mínimo para manter os dois lados
cotados. O corte de risco de verdade continua sendo `bidEnabled`/`askEnabled`
(`MAX_INVENTORY_SKEW`) no `InventoryManager`.

---

## 5. Estado dos testes

**79 pass · 11 skip · 2 fail** — mesmo número de falhas de antes, mas **testes diferentes**.

Antes das mudanças falhavam (sintomas dos bugs):
- `should respect optimistic locking and prevent over-allocation`
- `should keep the active order if price deviation is within tolerance and age < 10s`

Depois das mudanças falham (expectativas do contrato antigo):
- `should cancel and replace the order if price deviation exceeds tolerance (0.05%)` —
  espera `executeMakerBuy` 3×, agora é 1× porque `ORDER_LEVELS = 1`.
- `should cancel and replace the order if it is older than 10 seconds` — a ordem do teste tem
  11s e preço idêntico ao alvo; com `MAX_ORDER_AGE_MS = 60000` e sem drift de preço, não há
  mais motivo para cancelar.

Ambas as falhas são esperadas e refletem a mudança intencional de contrato. **Os testes
precisam ser reescritos** — ver item 1 do que falta.

---

## 6. O que ainda precisa ser feito

### Imediato

1. **Reescrever os 2 testes quebrados** de `tests/MarketMakerCycle.test.ts` para o novo
   contrato (1 nível, idade de 60s, gate de 30s, tolerância proporcional ao spread).
   Adicionar cobertura nova para: o gate de refresh não cancelar dentro dos 30s; o piso de
   notional aplicado depois do skew; e o descarte de níveis órfãos.
2. **Rodar `binance-audit.ts` em 24h de operação** com as mudanças em produção e comparar:
   - fill rate por ordem (era 0,03% — alvo: ordens de magnitude acima)
   - vida útil p50 das ordens (era 1,0s — alvo: dezenas de segundos)
   - razão ordem/trade (era 3.200:1)
   - edge bruto por notional (era −6,0 bps — alvo: positivo)
   - intervalo p50 entre pernas opostas (era 23min)

### Itens 4–7 do plano original (não implementados)

3. **Fazer o skew de preço realmente atuar** — hoje `reservationPrice` desloca ~1e-4%, o que
   é nada. É o que permite os 23 minutos de exposição direcional. O Hummingbot usa
   `inventory_skew_calculator` sobre os *tamanhos*, variando de 0 a 2×.
4. **Reaper de hanging orders** — cancelamento por idade e por drift de preço. Referência:
   `hanging_orders_cancel_pct` (default 10%) e `max_order_age` (default 1800s) no Hummingbot.
5. **Ler a taxa real da exchange** (`/sapi/v1/asset/tradeFee` ou a comissão realizada) em vez
   da lista hardcoded `zeroFeePromoBases`, com alarme se mudar.
6. **Recalibrar o simulador** contra os fills reais antes de usá-lo para qualquer decisão.
   Sem isso o backtest continua inutilizável como juiz.

### Backlog secundário

7. Volatilidade baseada em retornos log; eliminar a mutação de estado no getter.
8. Instrumentar markout dentro do próprio bot (com 31 fills em 2 dias não dá para medir nada;
   depois de corrigir o churn o volume sobe e markout vira a métrica de controle).
9. Adicionar `filled_order_delay` (Hummingbot: 60s) — hoje o bot re-cota imediatamente após
   um fill.
10. Remover o bloco morto de `shift` em `MarketMakerCycle.ts`.
11. Revisar `handleOrderFilled` — o default `isBuy = true` pode disparar ping-pong na direção
    errada quando o relatório não casa com nenhuma ordem rastreada.

---

## 7. Ressalvas sobre o diagnóstico

- **31 fills é amostra pequena.** O `−1,24 FDUSD` em 2 dias sobre ~165 FDUSD de capital
  (−0,75%) tem baixa significância estatística isoladamente.
- **Os achados estruturais não dependem disso.** 99.340 ordens para 31 fills, ordens de
  1 segundo, round-trip de 23 minutos e nunca voltar a flat são fatos mecânicos, não
  estatísticos.
- **O markout não pôde ser calculado** (8 fills nas 6h da amostra, abaixo do mínimo de 20
  exigido pelo script). Depois de corrigir o churn, essa passa a ser a métrica principal.
- **As chaves de API usadas na auditoria são as do `.env` local.** Se a VM usa outra conta,
  rodar o script lá para confirmar.
