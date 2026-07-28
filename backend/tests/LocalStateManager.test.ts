import { describe, it, expect } from "bun:test";
import { LocalStateManager } from "../src/application/LocalStateManager";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Tick } from "../src/domain/valueObjects/Tick";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";

describe("LocalStateManager", () => {
  it("should register a pair and update state with ticks", () => {
    const manager = new LocalStateManager();
    const pair = new Pair(new Currency("BTC"), new Currency("BRL"));
    
    manager.registerPair(pair);
    
    let book = manager.retrieveOrderBook(pair);
    expect(book.getLatest()).toBeUndefined();

    const tick = new Tick(pair, new Amount(100000));
    manager.updateState(tick);

    book = manager.retrieveOrderBook(pair);
    expect(book.getLatest()).toBeDefined();
    expect(book.getLatest()?.isForPair(pair)).toBeTrue();
  });

  it("should isolate different pairs", () => {
    const manager = new LocalStateManager();
    const btcBrl = new Pair(new Currency("BTC"), new Currency("BRL"));
    const ethBrl = new Pair(new Currency("ETH"), new Currency("BRL"));
    
    manager.registerPair(btcBrl);
    manager.registerPair(ethBrl);

    manager.updateState(new Tick(btcBrl, new Amount(100000)));

    expect(manager.retrieveOrderBook(btcBrl).getLatest()).toBeDefined();
    expect(manager.retrieveOrderBook(ethBrl).getLatest()).toBeUndefined();
  });
});
