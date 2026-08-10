---
name: mm-tuning
description: Guardrails para alterar a lógica de quoting, gestão de ordens ou parâmetros do market maker — spread, níveis, tolerância de refresh, idade de ordem, skew de estoque, dimensionamento de lote, hanging orders. Use antes de editar MarketMakerCycle, InventoryManager, os monitores (Volatility, Liquidity, TradeIntensity, CircuitBreaker) ou qualquer constante que afete preço, tamanho ou tempo de vida de ordem.
---

# Alterando o motor de market making

Cada invariante abaixo já foi violada neste projeto e custou dinheiro. Antes de mudar
qualquer parâmetro, verifique qual delas a mudança toca.

## As cinco invariantes

### 1. Cancelar ordem custa prioridade de fila

Uma ordem reposicionada volta para o fim da fila. Se as ordens vivem poucos segundos, a
única forma física de serem executadas é o preço atravessá-las — ou seja, **você só é
preenchido quando está errado**.

Medido aqui: `MAX_ORDER_AGE_MS = 3000` com loop de 2s produziu 99.340 ordens para 31 fills,
vida útil mediana de 1,00s e edge de −6,0 bps **com taxa zero**.

Qualquer mudança que reduza `MAX_ORDER_AGE_MS`, `ORDER_REFRESH_TIME_MS` ou a tolerância de
desvio precisa de justificativa forte e validação com dados reais. "Mais responsivo" não é
justificativa — foi exatamente o racional do commit que causou o problema.

Valores atuais e sua referência no Hummingbot:

| Parâmetro | Aqui | Hummingbot |
|---|---|---|
| `ORDER_REFRESH_TIME_MS` | 30.000 | `order_refresh_time` 30s |
| `MAX_ORDER_AGE_MS` | 60.000 | `max_order_age` 1800s |
| tolerância | `max(0.0005, effectiveSpread × 0.5)` | `order_refresh_tolerance_pct` |

A semântica é: a decisão de reposicionar é tomada **uma vez para o conjunto todo**, não por
nível. Preencher um nível vazio não é churn; cancelar e recolocar no mesmo preço é.

### 2. O spread cotado precisa cobrir `2 × feeRate`

`InventoryManager.getQuotes` calcula `feeFloor = 2 × feeRate × 1.5`. Se `feeRate` for zero
por engano, esse piso some e o bot cota abaixo do custo sem nenhum alarme.

Hoje BTCFDUSD tem promo de taxa zero, hardcoded em `index.ts` (`zeroFeePromoBases`). Confirme
com a taxa **realizada** (ver skill `audit-live`), nunca com `commissionRates` da conta.

### 3. Notional mínimo é restrição da exchange, não preferência de risco

Aplique o skew de estoque **antes** do piso de notional. A ordem inversa faz o skew empurrar
o lote de volta para baixo do mínimo, bloqueando o nível. E como o skew só encolhe o lado
comprador quando se está long, isso vira catraca: quanto mais long, mais a compra é
bloqueada, mais long fica.

Use `precisionFetcher.getMinNotional(symbol)`, nunca um literal. O corte de risco de verdade
é `bidEnabled`/`askEnabled` via `MAX_INVENTORY_SKEW`, não o piso de notional.

### 4. O ciclo precisa fechar em segundos

Se o intervalo entre uma compra e a venda seguinte é de minutos, o PnL é dominado por
movimento direcional. Medido aqui: p50 de 23 minutos. Isso não é market making.

`ORDER_LEVELS` hoje é 1. Com 3 níveis (fatores 1/1,5/2) são 4,5× o lote por lado — inviável
com capital pequeno, cada nível cai abaixo do mínimo. Só suba com capital proporcional.

### 5. Nenhum lado pode morrer em silêncio

Se um lado deixa de cotar por qualquer motivo que não seja o kill switch explícito, o estoque
deriva estruturalmente. Sempre logue via `logStuck`.

## Estado rastreado vs. exchange

O ciclo mantém quatro arrays: `activeBuyOrders`, `activeSellOrders`, `hangingBuyOrders`,
`hangingSellOrders`. O notional deles é descontado do saldo disponível. **Toda entrada que
não corresponde a uma ordem real na exchange bloqueia capital para sempre.**

Regras ao mexer nesse estado:

- Toda promessa de colocação precisa de `.then` **e** `.catch`. Sem o `.catch`, uma exceção
  deixa o lock otimista preso — foi a causa de `CANCEL_FAILED -1100` e de ~30 FDUSD
  bloqueados indefinidamente.
- Locks otimistas usam `PENDING_ORDER_ID` e nunca podem ser enviados a `cancelOrder`
  (a Binance exige `orderId` numérico). Cancele sempre via `cancelTracked()`.
- Hanging orders não passam pelo ciclo de refresh. Sem `reapHangingOrders` elas acumulam.
- `lockedQuote`/`lockedBase` são limitados pelo saldo justamente para que divergência de
  estado não gere "disponível" negativo e trave a cotação.
- Ao reiniciar o processo, ordens deixadas pela execução anterior ficam órfãs — o novo
  processo sobe com arrays vazios. `switchMode("LIVE")` chama `cancelAllOrders` e limpa.

## Validando a mudança

1. `bun test` — a suíte cobre tolerância, idade, lock otimista e bloqueio por saldo.
2. **Não use o backtest como juiz de lucratividade.** Ele superestima o fill rate em ~1.700×
   (`SimulationOrderExecutor` usa fila rasa demais; `HistoricalPriceIngestor` sintetiza book
   de profundidade 1 com spread fixo de 0,005%; os dados são só o *close* de klines de 1s).
   Serve para checar que o motor não quebra, não para decidir parâmetros.
3. Rode o bot 24h e compare com a skill `audit-live`. Métricas de controle, com a linha de
   base histórica:

   | Métrica | Base ruim | Alvo |
   |---|---|---|
   | fill rate por ordem | 0,03% | ordens de magnitude acima |
   | vida útil p50 | 1,00s | dezenas de segundos |
   | razão ordem/trade | 3.200:1 | duas ordens de magnitude abaixo |
   | edge bruto | −6,0 bps | positivo |
   | round-trip p50 | 23 min | segundos |

## Antes de inventar, consulte o Hummingbot

`scratch/hummingbot/` tem a implementação de referência. Veja a skill `hummingbot-ref`.

## Itens conhecidos ainda não resolvidos

Registrados em `docs/2026-08-10-auditoria-lucratividade.md`:

- Skew de preço é efetivamente nulo (`reservationPrice` desloca ~1e-4%).
- A matemática de Avellaneda-Stoikov é código morto — os termos são ~1e-7 e sempre
  sobrepostos pelos pisos no `Math.max`.
- `VolatilityMonitor` mede dispersão do nível de preço, não de retornos, e **muta estado** no
  getter (é chamado 2–3× por loop).
- Não existe `filled_order_delay`; o bot re-cota imediatamente após um fill.
- `handleOrderFilled` assume `isBuy = true` por default quando o relatório não casa com
  nenhuma ordem rastreada.
