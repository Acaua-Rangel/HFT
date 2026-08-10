/**
 * binance-audit.ts — Auditoria real de performance do market maker.
 *
 * Baixa da Binance (fonte da verdade, não o sqlite local):
 *   - Taxas REAIS da conta (maker/taker commission) — não assume 0.1%
 *   - Todos os fills (myTrades) no período
 *   - Todas as ordens (allOrders) — para medir churn de cancel/replace
 *   - Ordens abertas agora (openOrders) — para detectar hanging orders presas
 *   - Klines de 1s — para calcular MARKOUT (seleção adversa)
 *
 * Uso:
 *   bun run scripts/binance-audit.ts
 *   bun run scripts/binance-audit.ts --days=7 --symbols=BTCFDUSD,BTCBRL
 *   bun run scripts/binance-audit.ts --days=30 --markout-hours=48
 *
 * Flags:
 *   --days=N            janela de análise em dias (default 7)
 *   --symbols=A,B       força os símbolos (default: auto-descoberta)
 *   --markout-hours=N   horas mais recentes usadas no markout (default 24)
 *   --out=caminho.json  dump do resultado bruto
 */

import * as crypto from "crypto";
import * as fs from "fs";

const API = "https://api.binance.com";
const API_KEY = process.env.BINANCE_API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";

if (!API_KEY || !API_SECRET) {
    console.error("❌ BINANCE_API_KEY / BINANCE_API_SECRET ausentes no .env");
    process.exit(1);
}

// ---------- CLI ----------
function flag(name: string, def: string): string {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : def;
}
const DAYS = parseFloat(flag("days", "7"));
const MARKOUT_HOURS = parseFloat(flag("markout-hours", "24"));
const SYMBOLS_ARG = flag("symbols", "");
const OUT_PATH = flag("out", "");

const END_TIME = Date.now();
const START_TIME = END_TIME - DAYS * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// ---------- transporte ----------
let timeOffset = 0;
let weightUsed = 0;

async function raw(path: string, params: Record<string, any>, signed: boolean): Promise<any> {
    const p = { ...params };
    if (signed) {
        p.timestamp = Date.now() + timeOffset;
        p.recvWindow = 60000;
    }
    let qs = Object.entries(p)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
    if (signed) {
        const sig = crypto.createHmac("sha256", API_SECRET).update(qs).digest("hex");
        qs += `&signature=${sig}`;
    }

    for (let attempt = 0; attempt < 6; attempt++) {
        const res = await fetch(`${API}${path}?${qs}`, {
            headers: signed ? { "X-MBX-APIKEY": API_KEY } : {},
        });
        const w = res.headers.get("x-mbx-used-weight-1m");
        if (w) weightUsed = parseInt(w);

        if (res.status === 429 || res.status === 418) {
            const wait = parseInt(res.headers.get("retry-after") || "5") * 1000;
            console.warn(`⏳ rate limit (${res.status}), aguardando ${wait}ms…`);
            await sleep(wait);
            continue;
        }
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`${path} ${res.status}: ${body}`);
        }
        // freia preventivamente perto do teto de 6000/min
        if (weightUsed > 4800) await sleep(3000);
        return res.json();
    }
    throw new Error(`${path}: esgotou tentativas por rate limit`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pub = (path: string, params: Record<string, any> = {}) => raw(path, params, false);
const priv = (path: string, params: Record<string, any> = {}) => raw(path, params, true);

async function syncTime(): Promise<void> {
    const t0 = Date.now();
    const { serverTime } = await pub("/api/v3/time");
    timeOffset = serverTime - (t0 + Date.now()) / 2;
}

// ---------- tipos ----------
interface Trade {
    symbol: string;
    id: number;
    orderId: number;
    price: number;
    qty: number;
    quoteQty: number;
    commission: number;
    commissionAsset: string;
    time: number;
    isBuyer: boolean;
    isMaker: boolean;
}

interface Order {
    symbol: string;
    orderId: number;
    price: number;
    origQty: number;
    executedQty: number;
    status: string;
    type: string;
    side: string;
    time: number;
    updateTime: number;
}

/**
 * A Binance limita janelas de tempo a 24h e 1000 registros por resposta.
 * Bisseciona a janela sempre que a resposta vier cheia, garantindo cobertura total.
 */
async function fetchWindowed<T>(
    path: string,
    symbol: string,
    start: number,
    end: number,
    label: string
): Promise<T[]> {
    const out: T[] = [];
    const chunks: [number, number][] = [];
    for (let s = start; s < end; s += DAY_MS) chunks.push([s, Math.min(s + DAY_MS, end)]);

    const pending = [...chunks];
    while (pending.length) {
        const [s, e] = pending.shift()!;
        const batch = (await priv(path, { symbol, startTime: s, endTime: e, limit: 1000 })) as T[];
        if (batch.length >= 1000 && e - s > 60000) {
            const mid = Math.floor((s + e) / 2);
            pending.unshift([mid, e]);
            pending.unshift([s, mid]);
            continue;
        }
        out.push(...batch);
        process.stdout.write(`\r  ${label} ${symbol}: ${out.length}   `);
    }
    process.stdout.write(`\r  ${label} ${symbol}: ${out.length}   \n`);
    return out;
}

function num(o: any, k: string): number {
    return parseFloat(o[k] ?? "0");
}

// ---------- descoberta de símbolos ----------
async function discoverSymbols(balances: { asset: string; total: number }[]): Promise<string[]> {
    if (SYMBOLS_ARG) return SYMBOLS_ARG.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

    const info = await pub("/api/v3/exchangeInfo");
    const live = new Set<string>(
        info.symbols.filter((s: any) => s.status === "TRADING").map((s: any) => s.symbol)
    );

    const quotes = ["FDUSD", "USDT", "BRL", "USDC", "BUSD", "BTC"];
    const held = balances.filter(b => b.total > 0).map(b => b.asset);
    // pares do código + qualquer combinação plausível com o que a conta segura
    const candidates = new Set<string>(["BTCFDUSD", "BTCBRL"]);
    for (const a of held) for (const q of quotes) if (a !== q) candidates.add(`${a}${q}`);

    const valid = [...candidates].filter(c => live.has(c));
    console.log(`🔎 Sondando ${valid.length} pares candidatos por histórico de trades…`);

    const found: string[] = [];
    for (const sym of valid) {
        try {
            const t = await priv("/api/v3/myTrades", {
                symbol: sym,
                startTime: START_TIME,
                endTime: Math.min(START_TIME + DAY_MS, END_TIME),
                limit: 1,
            });
            // a primeira janela de 24h pode estar vazia; confirma olhando a mais recente
            const t2 = t.length
                ? t
                : await priv("/api/v3/myTrades", {
                      symbol: sym,
                      startTime: Math.max(END_TIME - DAY_MS, START_TIME),
                      endTime: END_TIME,
                      limit: 1,
                  });
            if (t2.length) {
                found.push(sym);
                console.log(`   ✓ ${sym}`);
            }
        } catch {
            /* símbolo sem permissão ou inexistente para a conta */
        }
    }
    return found;
}

// ---------- klines para markout ----------
async function fetchKlines1s(symbol: string, start: number, end: number): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    let cursor = start;
    let reqs = 0;
    while (cursor < end) {
        const data = (await pub("/api/v3/klines", {
            symbol,
            interval: "1s",
            startTime: cursor,
            endTime: end,
            limit: 1000,
        })) as any[][];
        if (!data.length) break;
        for (const k of data) map.set(Math.floor((k[0] as number) / 1000), parseFloat(k[4] as string));
        cursor = (data[data.length - 1]![0] as number) + 1000;
        reqs++;
        if (reqs % 20 === 0) process.stdout.write(`\r  klines 1s ${symbol}: ${map.size}s   `);
    }
    process.stdout.write(`\r  klines 1s ${symbol}: ${map.size}s   \n`);
    return map;
}

// ---------- conversão de comissões ----------
async function buildFxToQuote(assets: Set<string>, quote: string): Promise<Map<string, number>> {
    const fx = new Map<string, number>([[quote, 1]]);
    for (const a of assets) {
        if (fx.has(a)) continue;
        for (const sym of [`${a}${quote}`, `${quote}${a}`]) {
            try {
                const r = await pub("/api/v3/ticker/price", { symbol: sym });
                const p = parseFloat(r.price);
                fx.set(a, sym === `${a}${quote}` ? p : 1 / p);
                break;
            } catch {
                /* tenta a próxima orientação */
            }
        }
    }
    return fx;
}

// ---------- estatística ----------
function pct(n: number, d: number): string {
    return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
}
function quantile(sorted: number[], q: number): number {
    if (!sorted.length) return NaN;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

// ---------- main ----------
async function main() {
    await syncTime();

    console.log(`\n📅 Janela: ${new Date(START_TIME).toISOString()} → ${new Date(END_TIME).toISOString()} (${DAYS}d)\n`);

    // 1. Conta: taxas reais + saldos
    const account = await priv("/api/v3/account");
    const makerFee = num(account.commissionRates, "maker");
    const takerFee = num(account.commissionRates, "taker");
    const balances = (account.balances as any[])
        .map(b => ({ asset: b.asset, free: num(b, "free"), locked: num(b, "locked"), total: num(b, "free") + num(b, "locked") }))
        .filter(b => b.total > 0);

    console.log("═".repeat(70));
    console.log("TAXAS REAIS DA CONTA");
    console.log("═".repeat(70));
    console.log(`  maker: ${(makerFee * 100).toFixed(4)}%   taker: ${(takerFee * 100).toFixed(4)}%`);
    console.log(`  (o código assume 0.1000% fixo em index.ts:196)`);
    console.log(`  custo round-trip maker↔maker: ${(makerFee * 2 * 100).toFixed(4)}%`);
    console.log(`\n  Saldos não-zerados: ${balances.map(b => `${b.asset}=${b.total.toFixed(8)} (locked ${b.locked.toFixed(8)})`).join(", ") || "nenhum"}`);

    // 2. Símbolos
    const symbols = await discoverSymbols(balances);
    if (!symbols.length) {
        console.log("\n⚠️  Nenhum trade encontrado na janela. Use --symbols=XXX ou aumente --days.");
        return;
    }
    console.log(`\n📊 Símbolos com atividade: ${symbols.join(", ")}\n`);

    const report: any = { window: { START_TIME, END_TIME, days: DAYS }, makerFee, takerFee, symbols: {} };

    for (const symbol of symbols) {
        console.log("═".repeat(70));
        console.log(`SÍMBOLO: ${symbol}`);
        console.log("═".repeat(70));

        const info = await pub("/api/v3/exchangeInfo", { symbol });
        const baseAsset: string = info.symbols[0].baseAsset;
        const quoteAsset: string = info.symbols[0].quoteAsset;

        const rawTrades = await fetchWindowed<any>("/api/v3/myTrades", symbol, START_TIME, END_TIME, "trades");
        const rawOrders = await fetchWindowed<any>("/api/v3/allOrders", symbol, START_TIME, END_TIME, "ordens");

        const trades: Trade[] = rawTrades
            .map(t => ({
                symbol,
                id: t.id,
                orderId: t.orderId,
                price: num(t, "price"),
                qty: num(t, "qty"),
                quoteQty: num(t, "quoteQty"),
                commission: num(t, "commission"),
                commissionAsset: t.commissionAsset,
                time: t.time,
                isBuyer: t.isBuyer,
                isMaker: t.isMaker,
            }))
            .sort((a, b) => a.time - b.time);

        const orders: Order[] = rawOrders
            .map(o => ({
                symbol,
                orderId: o.orderId,
                price: num(o, "price"),
                origQty: num(o, "origQty"),
                executedQty: num(o, "executedQty"),
                status: o.status,
                type: o.type,
                side: o.side,
                time: o.time,
                updateTime: o.updateTime,
            }))
            .sort((a, b) => a.time - b.time);

        if (!trades.length) {
            console.log("  sem fills na janela\n");
            continue;
        }

        // --- PnL por fluxo de caixa ---
        const commissionAssets = new Set(trades.map(t => t.commissionAsset).filter(Boolean));
        const fx = await buildFxToQuote(commissionAssets, quoteAsset);
        const lastPrice = parseFloat((await pub("/api/v3/ticker/price", { symbol })).price);

        let quoteFlow = 0;   // quote recebido (+) / gasto (-), antes de taxas
        let baseFlow = 0;    // base ganho (+) / vendido (-), antes de taxas
        let feeQuote = 0;    // todas as comissões convertidas para quote
        let buyNotional = 0, sellNotional = 0, buyCount = 0, sellCount = 0;
        let makerCount = 0, takerCount = 0, makerNotional = 0, takerNotional = 0;

        for (const t of trades) {
            if (t.isBuyer) { quoteFlow -= t.quoteQty; baseFlow += t.qty; buyNotional += t.quoteQty; buyCount++; }
            else           { quoteFlow += t.quoteQty; baseFlow -= t.qty; sellNotional += t.quoteQty; sellCount++; }

            const rate = fx.get(t.commissionAsset);
            const feeInQuote = t.commissionAsset === baseAsset
                ? t.commission * t.price
                : t.commission * (rate ?? 0);
            feeQuote += feeInQuote;
            if (t.commissionAsset === baseAsset) baseFlow -= t.commission;
            else if (t.commissionAsset === quoteAsset) quoteFlow -= t.commission;

            if (t.isMaker) { makerCount++; makerNotional += t.quoteQty; }
            else           { takerCount++; takerNotional += t.quoteQty; }
        }

        const totalNotional = buyNotional + sellNotional;
        const inventoryMtm = baseFlow * lastPrice;
        const netPnl = quoteFlow + inventoryMtm;
        const grossPnl = netPnl + feeQuote;
        const spanH = (trades[trades.length - 1]!.time - trades[0]!.time) / 3600e3;

        console.log(`\n── VOLUME & TAXAS ──`);
        console.log(`  fills: ${trades.length}  (${(trades.length / Math.max(spanH, 1e-9)).toFixed(0)}/h ao longo de ${spanH.toFixed(2)}h)`);
        console.log(`  compras: ${buyCount} (${buyNotional.toFixed(2)} ${quoteAsset})   vendas: ${sellCount} (${sellNotional.toFixed(2)} ${quoteAsset})`);
        console.log(`  notional total girado: ${totalNotional.toFixed(2)} ${quoteAsset}`);
        console.log(`  maker: ${makerCount} (${pct(makerCount, trades.length)})   taker: ${takerCount} (${pct(takerCount, trades.length)})`);
        if (takerCount) console.log(`  ⚠️  ${takerNotional.toFixed(2)} ${quoteAsset} executado como TAKER (LIMIT_MAKER não deveria gerar taker)`);
        console.log(`  taxas pagas: ${feeQuote.toFixed(4)} ${quoteAsset}  (${(totalNotional > 0 ? feeQuote / totalNotional * 100 : 0).toFixed(5)}% do notional)`);

        console.log(`\n── PnL ──`);
        console.log(`  fluxo de quote:            ${quoteFlow >= 0 ? "+" : ""}${quoteFlow.toFixed(4)} ${quoteAsset}`);
        console.log(`  estoque residual:          ${baseFlow.toFixed(8)} ${baseAsset}  → ${inventoryMtm.toFixed(4)} ${quoteAsset} @ ${lastPrice}`);
        console.log(`  PnL BRUTO (antes taxas):   ${grossPnl >= 0 ? "+" : ""}${grossPnl.toFixed(4)} ${quoteAsset}`);
        console.log(`  taxas:                     -${feeQuote.toFixed(4)} ${quoteAsset}`);
        console.log(`  PnL LÍQUIDO:               ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(4)} ${quoteAsset}`);
        console.log(`  PnL por fill:              ${(netPnl / trades.length).toFixed(6)} ${quoteAsset}`);
        console.log(`  edge bruto por notional:   ${(totalNotional > 0 ? grossPnl / totalNotional * 1e4 : 0).toFixed(3)} bps`);
        console.log(`  drag de taxa por notional: ${(totalNotional > 0 ? -feeQuote / totalNotional * 1e4 : 0).toFixed(3)} bps`);

        // --- Churn de ordens ---
        const byStatus: Record<string, number> = {};
        for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
        const canceledNoFill = orders.filter(o => o.status === "CANCELED" && o.executedQty === 0);
        const lifetimes = canceledNoFill
            .map(o => o.updateTime - o.time)
            .filter(x => x >= 0)
            .sort((a, b) => a - b);

        console.log(`\n── CHURN DE ORDENS ──`);
        console.log(`  ordens colocadas: ${orders.length}`);
        for (const [s, c] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${s.padEnd(18)} ${String(c).padStart(7)}  ${pct(c, orders.length)}`);
        }
        console.log(`  canceladas sem nenhum fill: ${canceledNoFill.length} (${pct(canceledNoFill.length, orders.length)})`);
        console.log(`  fill rate por ordem: ${pct(orders.length - canceledNoFill.length, orders.length)}`);
        if (lifetimes.length) {
            console.log(`  vida útil das canceladas (ms): p50=${quantile(lifetimes, 0.5).toFixed(0)}  p90=${quantile(lifetimes, 0.9).toFixed(0)}  max=${lifetimes[lifetimes.length - 1]}`);
        }

        // --- Ordens abertas agora (hanging presas) ---
        const open = (await priv("/api/v3/openOrders", { symbol })) as any[];
        const openAged = open.map(o => ({
            side: o.side,
            price: num(o, "price"),
            qty: num(o, "origQty"),
            ageMin: (Date.now() - o.time) / 60000,
            driftPct: lastPrice > 0 ? (num(o, "price") - lastPrice) / lastPrice * 100 : 0,
        })).sort((a, b) => b.ageMin - a.ageMin);
        const openNotional = openAged.reduce((a, o) => a + o.price * o.qty, 0);

        console.log(`\n── ORDENS ABERTAS AGORA ──`);
        console.log(`  total: ${open.length}   notional preso: ${openNotional.toFixed(2)} ${quoteAsset}`);
        const stale = openAged.filter(o => o.ageMin > 5);
        console.log(`  com mais de 5 min de idade: ${stale.length}`);
        for (const o of openAged.slice(0, 10)) {
            console.log(`    ${o.side.padEnd(4)} ${o.qty} @ ${o.price}  idade=${o.ageMin.toFixed(1)}min  drift=${o.driftPct.toFixed(3)}%`);
        }

        // --- MARKOUT: o teste de seleção adversa ---
        const markoutStart = Math.max(trades[0]!.time, END_TIME - MARKOUT_HOURS * 3600e3);
        const moTrades = trades.filter(t => t.time >= markoutStart);
        console.log(`\n── MARKOUT (seleção adversa) ──`);
        console.log(`  amostra: ${moTrades.length} fills nas últimas ${MARKOUT_HOURS}h`);

        let markoutTable: any[] = [];
        if (moTrades.length >= 20) {
            const klines = await fetchKlines1s(symbol, markoutStart - 5000, END_TIME);
            const horizons = [1, 5, 10, 30, 60, 300];
            const priceAt = (sec: number): number | undefined => {
                for (let d = 0; d <= 5; d++) {
                    const p = klines.get(sec + d);
                    if (p !== undefined) return p;
                }
                return undefined;
            };

            console.log(`\n  Δt      markout médio    PnL implícito       fills`);
            console.log(`  ${"─".repeat(56)}`);
            for (const h of horizons) {
                let sumBps = 0, sumPnl = 0, n = 0;
                for (const t of moTrades) {
                    const t0 = Math.floor(t.time / 1000);
                    const p0 = priceAt(t0);
                    const p1 = priceAt(t0 + h);
                    if (p0 === undefined || p1 === undefined || p0 <= 0) continue;
                    // sinal: comprou → ganha se preço sobe; vendeu → ganha se preço cai
                    const sign = t.isBuyer ? 1 : -1;
                    const bps = (sign * (p1 - t.price) / t.price) * 1e4;
                    sumBps += bps;
                    sumPnl += (bps / 1e4) * t.quoteQty;
                    n++;
                }
                if (!n) continue;
                const avg = sumBps / n;
                const bar = avg < 0 ? "🔴" : "🟢";
                console.log(`  +${String(h).padEnd(4)}s  ${bar} ${avg.toFixed(3).padStart(8)} bps  ${sumPnl.toFixed(4).padStart(12)} ${quoteAsset}  ${String(n).padStart(7)}`);
                markoutTable.push({ horizonSec: h, avgBps: avg, implicitPnl: sumPnl, samples: n });
            }
            const feeBps = makerFee * 1e4;
            console.log(`\n  taxa maker por perna: ${feeBps.toFixed(3)} bps`);
            console.log(`  → para ser lucrativo, o markout precisa superar ${feeBps.toFixed(3)} bps em todos os horizontes.`);
        } else {
            console.log("  amostra insuficiente para markout");
        }

        // --- Detecção de round-trips ping-pong ---
        console.log(`\n── ROUND-TRIPS (detecção do ping-pong) ──`);
        const rts: number[] = [];
        const gaps: number[] = [];
        for (let i = 1; i < trades.length; i++) {
            const a = trades[i - 1]!, b = trades[i]!;
            if (a.isBuyer === b.isBuyer) continue;
            const spreadPct = a.isBuyer
                ? (b.price - a.price) / a.price * 100   // comprou depois vendeu
                : (a.price - b.price) / b.price * 100;  // vendeu depois comprou
            rts.push(spreadPct);
            gaps.push(b.time - a.time);
        }
        if (rts.length) {
            const sorted = [...rts].sort((x, y) => x - y);
            const gs = [...gaps].sort((x, y) => x - y);
            const avg = rts.reduce((x, y) => x + y, 0) / rts.length;
            const breakeven = makerFee * 2 * 100;
            const losing = rts.filter(r => r < breakeven).length;
            console.log(`  round-trips consecutivos detectados: ${rts.length}`);
            console.log(`  spread capturado: média=${avg.toFixed(4)}%  p25=${quantile(sorted, 0.25).toFixed(4)}%  p50=${quantile(sorted, 0.5).toFixed(4)}%  p75=${quantile(sorted, 0.75).toFixed(4)}%`);
            console.log(`  breakeven necessário (2× maker): ${breakeven.toFixed(4)}%`);
            console.log(`  round-trips abaixo do breakeven: ${losing} (${pct(losing, rts.length)})`);
            console.log(`  intervalo entre pernas (ms): p50=${quantile(gs, 0.5).toFixed(0)}  p90=${quantile(gs, 0.9).toFixed(0)}`);
        }

        // --- Evolução do estoque ---
        let pos = 0, maxPos = 0, minPos = 0;
        for (const t of trades) {
            pos += t.isBuyer ? t.qty : -t.qty;
            maxPos = Math.max(maxPos, pos);
            minPos = Math.min(minPos, pos);
        }
        console.log(`\n── ESTOQUE ──`);
        console.log(`  posição final: ${pos.toFixed(8)} ${baseAsset} (${(pos * lastPrice).toFixed(2)} ${quoteAsset})`);
        console.log(`  pico long: ${maxPos.toFixed(8)}   pico short: ${minPos.toFixed(8)} ${baseAsset}`);

        // --- PnL por hora ---
        const hourly = new Map<string, { pnl: number; fills: number; fees: number }>();
        for (const t of trades) {
            const key = new Date(t.time).toISOString().slice(0, 13);
            const e = hourly.get(key) || { pnl: 0, fills: 0, fees: 0 };
            e.pnl += t.isBuyer ? -t.quoteQty : t.quoteQty;
            const rate = fx.get(t.commissionAsset);
            e.fees += t.commissionAsset === baseAsset ? t.commission * t.price : t.commission * (rate ?? 0);
            e.fills++;
            hourly.set(key, e);
        }

        console.log(`\n── ATIVIDADE POR HORA (últimas 12) ──`);
        const hk = [...hourly.keys()].sort().slice(-12);
        for (const k of hk) {
            const e = hourly.get(k)!;
            console.log(`  ${k}Z  fills=${String(e.fills).padStart(6)}  fluxo=${e.pnl.toFixed(2).padStart(12)}  taxas=${e.fees.toFixed(4).padStart(10)} ${quoteAsset}`);
        }
        console.log("");

        report.symbols[symbol] = {
            baseAsset, quoteAsset, lastPrice,
            fills: trades.length, buyCount, sellCount, spanHours: spanH,
            buyNotional, sellNotional, totalNotional,
            makerCount, takerCount, takerNotional,
            feeQuote, quoteFlow, baseFlow, inventoryMtm, grossPnl, netPnl,
            orders: { total: orders.length, byStatus, canceledNoFill: canceledNoFill.length,
                      lifetimeP50: lifetimes.length ? quantile(lifetimes, 0.5) : null,
                      lifetimeP90: lifetimes.length ? quantile(lifetimes, 0.9) : null },
            openOrders: { count: open.length, notional: openNotional, staleOver5min: stale.length, sample: openAged.slice(0, 20) },
            markout: markoutTable,
            roundTrips: rts.length ? {
                count: rts.length,
                avgPct: rts.reduce((x, y) => x + y, 0) / rts.length,
                belowBreakeven: rts.filter(r => r < makerFee * 2 * 100).length,
            } : null,
            inventory: { final: pos, maxLong: maxPos, maxShort: minPos },
        };
    }

    // --- Consolidado ---
    const syms = Object.values(report.symbols) as any[];
    if (syms.length) {
        console.log("═".repeat(70));
        console.log("CONSOLIDADO");
        console.log("═".repeat(70));
        const tf = syms.reduce((a, s) => a + s.feeQuote, 0);
        const tn = syms.reduce((a, s) => a + s.netPnl, 0);
        const tg = syms.reduce((a, s) => a + s.grossPnl, 0);
        const tv = syms.reduce((a, s) => a + s.totalNotional, 0);
        console.log(`  notional girado: ${tv.toFixed(2)}`);
        console.log(`  PnL bruto: ${tg >= 0 ? "+" : ""}${tg.toFixed(4)}   taxas: -${tf.toFixed(4)}   PnL líquido: ${tn >= 0 ? "+" : ""}${tn.toFixed(4)}`);
        console.log(`  (valores em cada quote asset; não somar entre quotes diferentes cegamente)\n`);
    }

    const outPath = OUT_PATH || `/tmp/binance-audit-${END_TIME}.json`;
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`💾 Resultado bruto: ${outPath}`);
    console.log(`📉 Peso de API usado no último minuto: ${weightUsed}/6000\n`);
}

main().catch(e => { console.error("\n❌", e.message); process.exit(1); });
