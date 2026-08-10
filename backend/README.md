# backend

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Atualizações de Arquitetura (Inspiradas no Hummingbot)

- **Loop Recursivo Deterministíco:** O `setInterval` foi substituído por `setTimeout` recursivo no `index.ts`, garantindo que um novo ciclo de avaliação só se inicie após a conclusão completa do ciclo atual, evitando sobreposição de ticks.
- **Rastreamento Ativo de Ordens (Active Order Tracking):** As ordens não bloqueiam mais a execução com um `ttlMs`. O `OrderExecutor` agora retorna uma referência à ordem (`ActiveOrder`) imediatamente após a postagem. O `MarketMakerCycle` rastreia essa ordem e só a cancela se houver um desvio de preço maior que a tolerância (`TOLERANCE_PCT` = 0.05%) ou se o tempo de vida máximo for atingido (`MAX_ORDER_AGE_MS` = 10s).
- **Matemática Avellaneda-Stoikov Real:** O `InventoryManager` agora utiliza as equações reais do modelo de Avellaneda-Stoikov para calcular o preço de reserva (deslocamento baseado em inventário, aversão ao risco e volatilidade) e o spread ideal (baseado em intensidade de liquidez e variância). As restrições de piso (Taxas e Proteção de Volatilidade Absoluta) garantem a segurança do spread calculado pelas fórmulas.
