---
name: audit-live
description: Auditar a performance real do bot baixando trades, ordens, taxas e ordens abertas da Binance, e interpretar as métricas de market making (fill rate, markout, round-trip, churn, estoque). Use quando perguntarem se o bot está lucrativo, por que está perdendo dinheiro, quanto pagou de taxa, se uma mudança melhorou, quando houver suspeita de ordens fantasma ou saldo preso, ou sempre que alguém apresentar o sqlite local ou o backtest como evidência de performance.
---

# Auditoria de performance real

## Regra zero

**O sqlite local e o backtest não são evidência de performance.**

- `backend/hft.sqlite` contém dados de simulação (`status = "SIM_LIMIT_MAKER"`) e pode estar
  defasado em relação à VM. Já levou a um diagnóstico completamente errado.
- O backtest superestima o fill rate em ~1.700× (1.433 fills/h simulados vs 0,86 reais).

Se alguém apresentar números dessas fontes, diga isso e rode a auditoria real.

## Como rodar

```bash
cd backend
bun run scripts/binance-audit.ts --days=7 --markout-hours=48
```

Flags: `--days=N`, `--symbols=A,B` (pula a auto-descoberta), `--markout-hours=N`,
`--out=arquivo.json`.

Operacional:
- **Nunca use pipe para `tail`/`head`** — a saída fica em buffer e você não vê progresso.
  Redirecione: `> /tmp/audit.log 2>&1` e leia o arquivo.
- Rode em background. Com dezenas de milhares de ordens a paginação por bissecção leva
  vários minutos (o script divide janelas de 24h ao meio quando a resposta vem cheia).
- Read-only: só endpoints de consulta. Não precisa de confirmação.
- Se a VM usa credenciais diferentes das do `.env` local, rode lá.

Para uma pergunta pontual (ordens abertas agora, saldo travado), não rode a auditoria
inteira — faça uma chamada assinada direta a `/api/v3/openOrders` e `/api/v3/account`.
É segundos em vez de minutos.

## Como interpretar

Leia nesta ordem. As três primeiras respondem quase tudo.

### 1. Edge bruto por notional (bps)

PnL antes de taxas ÷ notional girado. É a métrica central.

- **Negativo com taxa zero** ⇒ seleção adversa. Não há custo para culpar: o bot está sendo
  executado no lado errado. Vá direto ao churn.
- **Positivo mas abaixo da taxa** ⇒ captura spread, mas não o bastante para pagar a
  corretora. Alargue o spread ou reduza o giro.

### 2. Churn de ordens

Compare `ordens colocadas` com `fills`.

- **Razão acima de ~100:1** ⇒ churn patológico. Olhe `vida útil das canceladas p50`.
- **p50 de poucos segundos** ⇒ as ordens nunca ganham prioridade de fila; a única forma de
  serem executadas é o preço atravessá-las. Causa raiz mais provável de edge negativo.
- Referência histórica: 99.340 ordens para 31 fills, p50 de 1,00s, edge de −6,0 bps.
- Razão ordem/trade alta também é **risco de restrição de conta** na Binance.

### 3. Round-trips

`intervalo entre pernas p50` diz se isto é market making ou trading direcional acidental.

- **Segundos** ⇒ market making de verdade.
- **Minutos** ⇒ o PnL é dominado pelo movimento do preço, não pelo spread. Referência
  histórica: p50 de 23 minutos.

`spread capturado médio` negativo = comprou caro, vendeu barato, independente do que cotou.

### 4. Markout

Precisa de ≥20 fills na janela. É o teste definitivo de seleção adversa: markout médio
negativo em todos os horizontes significa que o preço se move contra você logo após cada
execução. Compare com a taxa maker em bps — o markout precisa superá-la para haver lucro.

### 5. Estoque e ordens abertas

- `pico short = 0` com posição final grande ⇒ nunca volta a flat, estruturalmente comprado.
- `locked` alto no base com `locked = 0` no quote ⇒ só há vendas descansando; o lado da
  compra está bloqueado.
- Ordens abertas antigas ⇒ hanging orders presas.

### 6. Taxas

`taxas pagas (% do notional)` é a taxa **realizada** — mais confiável que `commissionRates`
da conta, que é o tier default e não reflete promoções por símbolo.

Para BTCFDUSD: 0,000% significa que a promo está ativa e o hardcode `zeroFeePromoBases` em
`index.ts` está correto. Se der ~0,1%, a promo acabou e o bot está cotando abaixo do custo —
emergência.

## Cruzamento obrigatório: estado rastreado vs. exchange

Sempre que aparecer `BUY L0 BLOCKED` ou `SELL L0 BLOCKED` nos logs, compare o `lockedQuote`
implícito com o que a exchange realmente tem:

```
Free(Available) reportado = quoteBalance − lockedQuote
```

Se a exchange mostra `FDUSD locked = 0` e nenhuma ordem de compra aberta, mas o bot acha que
tem saldo travado, então há **ordens fantasma** nos arrays rastreados. Já aconteceu: um lock
otimista preso descontava ~30 FDUSD de um pedido que nunca existiu, bloqueando o lado da
compra permanentemente e gerando `CANCEL_FAILED -1100`.

Lembre que `BinanceBalanceFetcher` retorna `free + locked` (total), então descontar
`lockedQuote` é correto — não é dupla contagem. O problema, quando aparece, é o estado
rastreado divergir da realidade.

## Ao reportar

Traga números, não adjetivos. Separe:

- **Achados mecânicos** — contagens de ordens, vida útil, razão ordem/trade, ordens abertas.
  Não dependem de tamanho de amostra.
- **Achados estatísticos** — PnL, markout. Dependem.

Com poucas dezenas de fills, diga explicitamente que o PnL tem baixa significância e apoie o
diagnóstico nos mecânicos.
