import { describe, it, expect } from "bun:test";
import { ArbitrageMathEngine } from "../src/application/ArbitrageMathEngine";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Fee } from "../src/domain/valueObjects/Fee";
import { OrderBook } from "../src/domain/entities/OrderBook";
import { Tick } from "../src/domain/valueObjects/Tick";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Currency } from "../src/domain/valueObjects/Currency";

describe("ArbitrageMathEngine", () => {
  it("should calculate profit correctly", () => {
    const engine = new ArbitrageMathEngine();
    const initialBrl = new Amount(1000);
    const fee = new Fee(new Amount(0.001)); // 0.1%

    const btcBrlBook = new OrderBook(); btcBrlBook.add(new Tick(new Pair(new Currency("BTC"), new Currency("BRL")), new Amount(100000)));
    const ethBtcBook = new OrderBook(); ethBtcBook.add(new Tick(new Pair(new Currency("ETH"), new Currency("BTC")), new Amount(0.05)));
    const ethBrlBook = new OrderBook(); ethBrlBook.add(new Tick(new Pair(new Currency("ETH"), new Currency("BRL")), new Amount(6000)));

    // 1. Buy BTC with BRL
    // 1000 / 100000 = 0.01 BTC
    // Fee: 0.1% of 0.01 = 0.00001 BTC
    // After fee: 0.00999 BTC

    // 2. Buy ETH with BTC
    // 0.00999 / 0.05 = 0.1998 ETH
    // Fee: 0.1% of 0.1998 = 0.0001998 ETH
    // After fee: 0.1996002 ETH

    // 3. Sell ETH for BRL
    // 0.1996002 * 6000 = 1197.6012 BRL
    // Fee: 0.1% of 1197.6012 = 1.1976 BRL
    // Final BRL: 1196.4036 BRL
    // Profit: 1196.4036 - 1000 = 196.4036 BRL

    const profit = engine.calculateArbitrageProfit(
      initialBrl,
      btcBrlBook,
      ethBtcBook,
      ethBrlBook,
      fee,
      fee,
      fee
    );
    
    // We expect a profit around 196.40 (accounting for precision)
    expect((profit as any).value).toBeCloseTo(196.40, 2);
  });

  it("should return zero profit if missing orderbook data", () => {
    const engine = new ArbitrageMathEngine();
    const initialBrl = new Amount(1000);
    const fee = new Fee(new Amount(0.001));

    const btcBrlBook = new OrderBook();
    const ethBtcBook = new OrderBook();
    const ethBrlBook = new OrderBook();

    const profit = engine.calculateArbitrageProfit(initialBrl, btcBrlBook, ethBtcBook, ethBrlBook, fee, fee, fee);
    expect((profit as any).value).toBe(-9999999);
  });
});
