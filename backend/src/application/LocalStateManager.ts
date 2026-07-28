import { StateManager } from "../domain/interfaces/StateManager";
import { OrderBook } from "../domain/entities/OrderBook";
import { Pair } from "../domain/valueObjects/Pair";
import { Tick } from "../domain/valueObjects/Tick";

class PairOrderBook {
  constructor(
    private readonly pair: Pair,
    private readonly orderBook: OrderBook
  ) {}

  public updateIfMatches(tick: Tick): PairOrderBook {
    const isMatch = tick.isForPair(this.pair);
    if (!isMatch) {
      return this;
    }
    const updatedBook = this.orderBook.add(tick);
    return new PairOrderBook(this.pair, updatedBook);
  }

  public matchesPair(targetPair: Pair): boolean {
    return this.pair.isEquals(targetPair);
  }

  public retrieveBook(): OrderBook {
    return this.orderBook;
  }
}

class OrderBookCollection {
  constructor(private readonly items: PairOrderBook[] = []) {}

  public add(item: PairOrderBook): OrderBookCollection {
    return new OrderBookCollection([...this.items, item]);
  }

  public applyTick(tick: Tick): OrderBookCollection {
    const updatedItems = this.items.map((item) => item.updateIfMatches(tick));
    return new OrderBookCollection(updatedItems);
  }

  public findBookFor(pair: Pair): OrderBook {
    const found = this.items.find((item) => item.matchesPair(pair));
    const hasFound = found !== undefined;
    if (hasFound) {
      return found.retrieveBook();
    }
    return new OrderBook();
  }
}

export class LocalStateManager implements StateManager {
  constructor(private collection: OrderBookCollection = new OrderBookCollection()) {}

  public registerPair(pair: Pair): void {
    const emptyBook = new OrderBook();
    const pairBook = new PairOrderBook(pair, emptyBook);
    this.collection = this.collection.add(pairBook);
  }

  public updateState(tick: Tick): void {
    this.collection = this.collection.applyTick(tick);
  }

  public retrieveOrderBook(pair: Pair): OrderBook {
    return this.collection.findBookFor(pair);
  }
}
