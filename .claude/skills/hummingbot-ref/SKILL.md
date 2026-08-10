---
name: hummingbot-ref
description: Consultar a implementação de referência do Hummingbot em scratch/hummingbot antes de projetar ou alterar qualquer mecanismo de market making — refresh de ordens, hanging orders, skew de estoque, Avellaneda-Stoikov, price bands, delay pós-fill. Use quando precisar saber como a comunidade resolve um problema de quoting, comparar defaults, ou justificar a escolha de um parâmetro.
---

# Referência: Hummingbot

`scratch/hummingbot/` (581 MB, Python/Cython) é a implementação de referência da comunidade.
**Não é código do projeto** — nada dali roda, nada dali deve ser importado. É consulta.

A regra prática: antes de inventar um mecanismo de quoting, veja como o Hummingbot resolve.
Quando divergir dele, tenha um motivo escrito.

## Mapa dos arquivos que importam

Todos relativos a `scratch/hummingbot/`.

| Assunto | Arquivo |
|---|---|
| Estratégia principal | `hummingbot/strategy/pure_market_making/pure_market_making.pyx` |
| Defaults dos parâmetros | `hummingbot/strategy/pure_market_making/pure_market_making_config_map.py` |
| Skew de estoque sobre tamanhos | `hummingbot/strategy/pure_market_making/inventory_skew_calculator.pyx` |
| Ciclo de vida de hanging orders | `hummingbot/strategy/hanging_orders_tracker.py` |
| Avellaneda-Stoikov de verdade | `hummingbot/strategy/avellaneda_market_making/avellaneda_market_making.pyx` |
| Banda de preço móvel | `hummingbot/strategy/pure_market_making/moving_price_band.py` |

Outras estratégias em `hummingbot/strategy/` (`cross_exchange_market_making`,
`liquidity_mining`, `amm_arb`) só interessam se o assunto for aquele modelo específico.

## Pontos de entrada dentro de `pure_market_making.pyx`

Procure por estes símbolos — são os que respondem quase toda pergunta de design:

- `c_cancel_active_orders` — a semântica de tolerância. O ponto central: se todos os preços
  propostos estão dentro da tolerância, ele **adia o cancelamento** (`to_defer_canceling`)
  em vez de recolocar. É o oposto de cancelar por nível.
- `c_cancel_active_orders_on_max_age_limit` — expiração por idade, separada da tolerância.
- `c_to_create_orders` — só cria quando **não há** ordens ativas não-hanging. Evita
  sobreposição de ordem antiga com nova.
- `c_did_complete_buy_order` / `c_did_complete_sell_order` — aplicam `filled_order_delay`
  via `_create_timestamp = _current_timestamp + _filled_order_delay`. Depois de um fill, o
  bot **espera** antes de re-cotar.
- `c_cancel_orders_below_min_spread` — cancela ordens que ficaram perto demais do mid.

## Defaults (de `pure_market_making_config_map.py`)

Úteis como âncora ao discutir parâmetros:

| Parâmetro | Default |
|---|---|
| `order_refresh_time` | 30s |
| `max_order_age` | 1800s (30 min) |
| `filled_order_delay` | 60s |
| `order_levels` | 1 |
| `order_refresh_tolerance_pct` | 0 |
| `hanging_orders_cancel_pct` | 10% |
| `inventory_target_base_pct` | 50% |

Compare sempre com os valores em `MarketMakerCycle.ts` e `InventoryManager.ts`. Divergências
grandes (ex.: `max_order_age` de 3s contra 1800s) são sinal de problema, não de otimização.

## Como consultar com eficiência

O repositório é grande; não o leia inteiro.

```bash
cd scratch/hummingbot
grep -n "filled_order_delay\|order_refresh_time" hummingbot/strategy/pure_market_making/pure_market_making.pyx
grep -n "default=" hummingbot/strategy/pure_market_making/pure_market_making_config_map.py
```

Para ler um método Cython inteiro, delimite com `sed`:

```bash
sed -n '/cdef c_cancel_active_orders/,/cdef c_cancel_orders_below_min_spread/p' \
  hummingbot/strategy/pure_market_making/pure_market_making.pyx
```

Cuidado ao ler `config_map.py`: os `default=` aparecem depois do `prompt`, então um `grep`
só de `default=` perde a associação com a chave. Confira o número da linha contra o
`ConfigVar(key=...)` correspondente.

## Onde já divergimos de propósito

- **`ORDER_LEVELS = 1`** — igual ao default do Hummingbot, mas aqui por restrição de capital
  (3 níveis com fatores 1/1,5/2 exigem 4,5× o lote por lado e cada um cai abaixo do notional
  mínimo).
- **Tolerância proporcional ao spread** (`max(0.0005, effectiveSpread × 0.5)`) em vez do
  `order_refresh_tolerance_pct` fixo — no Hummingbot a proteção real contra churn é o gate
  temporal, não a tolerância; aqui usamos os dois.
- **Ping-pong próprio** (`PING_PONG_SPREAD`) que o Hummingbot não tem. Ele usa
  `filled_order_delay` + hanging orders. Nosso mecanismo ainda não foi validado com dados.

## Divergências que ainda são dívida

Ver `docs/2026-08-10-auditoria-lucratividade.md`. As principais:

- Não temos `filled_order_delay` — re-cotamos imediatamente após um fill.
- Nosso skew de estoque atua no preço com magnitude ~1e-4% (efetivamente nada), enquanto o
  `inventory_skew_calculator` do Hummingbot atua nos **tamanhos**, variando de 0 a 2×.
- Nosso reaper de hanging orders usa idade e drift; o Hummingbot tem um tracker dedicado com
  máquina de estados (`hanging_orders_tracker.py`) que vale estudar se o mecanismo crescer.
