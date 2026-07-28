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

  public find(symbol: string, callback: (pair: Pair) => void): void {
    const found = this.map.get(symbol);
    const hasFound = found !== undefined;
    if (hasFound) {
      callback(found!);
    }
  }
}

class IngestorState {
  private pendingPayloads: string[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly subscriptions: SubscriptionMap
  ) {
    this.ws.onopen = this.flushPending.bind(this);
  }

  private flushPending(): void {
    this.pendingPayloads.forEach(payload => {
      this.ws.send(payload);
    });
    this.pendingPayloads = [];
  }

  public sendToWs(payloadString: string): void {
    const isOpen = this.ws.readyState === WebSocket.OPEN;
    if (isOpen) {
      this.ws.send(payloadString);
      return;
    }
    this.pendingPayloads = [...this.pendingPayloads, payloadString];
  }

  public attachWsHandler(handler: (event: MessageEvent) => void): void {
    this.ws.onmessage = handler;
  }

  public registerSubscription(symbol: string, pair: Pair): void {
    this.subscriptions.register(symbol, pair);
  }

  public findPairAndApply(symbol: string, callback: (pair: Pair) => void): void {
    this.subscriptions.find(symbol, callback);
  }
}

export class BinancePriceIngestor implements PriceIngestor {
  private readonly callbacks: IngestorCallbacks = new IngestorCallbacks();
  private readonly state: IngestorState;

  constructor() {
    this.state = new IngestorState(
      new WebSocket("wss://stream.binance.com:9443/ws"),
      new SubscriptionMap()
    );
    this.state.attachWsHandler(this.handleMessage.bind(this));
  }

  public subscribe(pair: Pair): void {
    pair.applyBinanceStreamFormat((streamName) => {
      this.sendSubscriptionPayload(streamName);
      this.registerPairMapping(streamName, pair);
    });
  }

  private sendSubscriptionPayload(streamName: string): void {
    const payload = {
      method: "SUBSCRIBE",
      params: [streamName],
      id: Date.now(),
    };
    this.state.sendToWs(JSON.stringify(payload));
  }

  private registerPairMapping(streamName: string, pair: Pair): void {
    const symbolStr = streamName.replace("@bookTicker", "").toUpperCase();
    this.state.registerSubscription(symbolStr, pair);
  }

  public onTick(callback: (tick: Tick) => void): void {
    this.callbacks.add(callback);
  }

  private handleMessage(event: MessageEvent): void {
    const rawString = String(event.data);
    const parsedData = JSON.parse(rawString);
    this.processBookTicker(parsedData);
  }

  private processBookTicker(payload: any): void {
    const isValid = payload.s !== undefined && payload.a !== undefined;
    if (!isValid) {
      return;
    }

    const symbol = String(payload.s);
    const askPriceVal = parseFloat(String(payload.a));

    this.state.findPairAndApply(symbol, (pair) => {
      this.createAndNotifyTick(pair, askPriceVal);
    });
  }

  private createAndNotifyTick(pair: Pair, priceVal: number): void {
    const price = new Amount(priceVal);
    const tick = new Tick(pair, price);
    this.callbacks.notifyAll(tick);
  }
}
