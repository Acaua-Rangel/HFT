import { PriceIngestor } from "../domain/interfaces/PriceIngestor";
import { Pair } from "../domain/valueObjects/Pair";
import { Tick } from "../domain/valueObjects/Tick";
import { Amount } from "../domain/valueObjects/Amount";

class IngestorCallbacks {
  constructor(private readonly list: ((tick: Tick) => void)[] = []) {}

  public add(cb: (tick: Tick) => void): void {
    this.list.push(cb);
  }

  public notifyAll(tick: Tick): void {
    this.list.forEach((cb) => cb(tick));
  }
}

class SubscriptionMap {
  constructor(private readonly map: Map<string, Pair> = new Map()) {}

  public register(symbol: string, pair: Pair): void {
    this.map.set(symbol, pair);
  }

  public has(symbol: string): boolean {
    return this.map.has(symbol);
  }

  public find(symbol: string, callback: (pair: Pair) => void): void {
    const found = this.map.get(symbol);
    const hasFound = found !== undefined;
    if (hasFound) {
      callback(found!);
    }
  }
}

class IngestorState {
  private pendingStreams: string[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly subscriptions: SubscriptionMap
  ) {
    this.ws.onopen = () => {
      console.log("📡 Binance WebSocket connected. Subscribing to streams...");
      this.flushPending();
    };
    this.ws.onerror = (err) => {
      console.error("❌ Binance WebSocket error:", err);
    };
    this.ws.onclose = () => {
      console.warn("⚠️ Binance WebSocket disconnected.");
    };
  }

  private flushPending(): void {
    if (this.pendingStreams.length === 0) return;

    // Batch ALL streams into a single SUBSCRIBE message
    const payload = {
      method: "SUBSCRIBE",
      params: this.pendingStreams,
      id: Date.now(),
    };
    this.ws.send(JSON.stringify(payload));
    console.log(`📡 Subscribed to ${this.pendingStreams.length} streams: ${this.pendingStreams.join(", ")}`);
    this.pendingStreams = [];
  }

  public queueStream(streamName: string): void {
    const isOpen = this.ws.readyState === WebSocket.OPEN;
    if (isOpen) {
      // WS already open, send immediately as single batch
      const payload = {
        method: "SUBSCRIBE",
        params: [streamName],
        id: Date.now(),
      };
      this.ws.send(JSON.stringify(payload));
      return;
    }
    this.pendingStreams.push(streamName);
  }

  public attachWsHandler(handler: (event: MessageEvent) => void): void {
    this.ws.onmessage = handler;
  }

  public registerSubscription(symbol: string, pair: Pair): void {
    this.subscriptions.register(symbol, pair);
  }

  public isSubscribed(symbol: string): boolean {
    return this.subscriptions.has(symbol);
  }

  public findPairAndApply(symbol: string, callback: (pair: Pair) => void): void {
    this.subscriptions.find(symbol, callback);
  }
}

export class BinancePriceIngestor implements PriceIngestor {
  private readonly callbacks: IngestorCallbacks = new IngestorCallbacks();
  private readonly state: IngestorState;
  private tickCount = 0;

  constructor() {
    this.state = new IngestorState(
      new WebSocket("wss://stream.binance.com:9443/stream"),
      new SubscriptionMap()
    );
    this.state.attachWsHandler(this.handleMessage.bind(this));
  }

  public subscribe(pair: Pair): void {
    pair.applyBinanceStreamFormat((streamName) => {
      const symbolStr = streamName.replace("@depth5@100ms", "").toUpperCase();

      // Deduplicate: don't subscribe twice for the same symbol
      if (this.state.isSubscribed(symbolStr)) {
        return;
      }

      this.state.queueStream(streamName);
      this.state.registerSubscription(symbolStr, pair);
    });
  }

  public onTick(callback: (tick: Tick) => void): void {
    this.callbacks.add(callback);
  }

  private handleMessage(event: MessageEvent): void {
    const rawString = String(event.data);
    const parsedData = JSON.parse(rawString);
    this.processDepthStream(parsedData);
  }

  private processDepthStream(payload: any): void {
    if (!payload.stream || !payload.data || !payload.data.asks || !payload.data.bids) {
      return;
    }

    const symbol = payload.stream.replace("@depth5@100ms", "").toUpperCase();
    const data = payload.data;

    this.tickCount++;
    if (this.tickCount === 1 || this.tickCount % 1000 === 0) {
      const topAsk = data.asks[0] ? data.asks[0][0] : "N/A";
      const topBid = data.bids[0] ? data.bids[0][0] : "N/A";
      console.log(`📈 Tick [${this.tickCount}]: ${symbol} | Top Ask: ${topAsk} | Top Bid: ${topBid}`);
    }

    this.state.findPairAndApply(symbol, (pair) => {
      this.createAndNotifyTick(pair, data.asks, data.bids);
    });
  }

  private createAndNotifyTick(pair: Pair, rawAsks: string[][], rawBids: string[][]): void {
    const asks = rawAsks.map(level => ({
      price: new Amount(parseFloat(level[0])),
      qty: new Amount(parseFloat(level[1]))
    }));

    const bids = rawBids.map(level => ({
      price: new Amount(parseFloat(level[0])),
      qty: new Amount(parseFloat(level[1]))
    }));

    const tick = new Tick(pair, asks, bids);
    this.callbacks.notifyAll(tick);
  }
}
