import { BinanceWsClient, WsResponse } from "./BinanceWsClient";

export interface ExecutionReport {
    symbol: string;
    orderId: number;
    clientOrderId: string;
    side: "BUY" | "SELL";
    type: string;
    timeInForce: string;
    originalQty: number;
    originalPrice: number;
    executionType: string; // NEW, CANCELED, REPLACED, REJECTED, TRADE, EXPIRED
    orderStatus: string;   // NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED
    lastFilledQty: number;
    accumulatedFilledQty: number;
    lastFilledPrice: number;
    commissionAsset: string;
    commission: number;
    tradeTime: number;
}

export class BinanceUserDataStream {
    private ws: WebSocket | null = null;
    private listenKey: string | null = null;
    private keepAliveInterval: any = null;
    
    private onOrderFilledCallbacks: ((report: ExecutionReport) => void)[] = [];
    private onOrderCanceledCallbacks: ((report: ExecutionReport) => void)[] = [];

    constructor(
        private readonly wsApiClient: BinanceWsClient,
        private readonly streamUrl: string = "wss://stream.binance.com:9443/ws/"
    ) {}

    public async connect(): Promise<void> {
        if (!this.wsApiClient.isReady()) {
            throw new Error("WS API Client must be ready to fetch ListenKey");
        }

        // 1. Fetch ListenKey
        const startRes: WsResponse = await this.wsApiClient.sendRequest("userDataStream.start", {}, 3000, false);
        if (startRes.status !== 200 || !startRes.result?.listenKey) {
            throw new Error(`Failed to start User Data Stream: ${JSON.stringify(startRes.error || startRes.result)}`);
        }
        
        this.listenKey = startRes.result.listenKey;
        
        // 2. Connect to Stream
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`${this.streamUrl}${this.listenKey}`);
            
            this.ws.onopen = () => {
                console.log("🟢 [UserDataStream] Connected");
                this.startKeepAlive();
                resolve();
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data.toString());
                    this.handleMessage(data);
                } catch (err) {
                    console.error("[UserDataStream] Parse error", err);
                }
            };

            this.ws.onerror = (err) => {
                console.error("🔴 [UserDataStream] Error", err);
                reject(err);
            };

            this.ws.onclose = () => {
                console.log("🔴 [UserDataStream] Disconnected");
                this.stopKeepAlive();
                this.ws = null;
                
                // Auto-reconnect after 5 seconds if we still have a listenKey
                if (this.listenKey) {
                    console.log("🔄 [UserDataStream] Attempting to reconnect in 5s...");
                    setTimeout(() => {
                        this.connect().catch(err => console.error("Failed to reconnect", err));
                    }, 5000);
                }
            };
        });
    }

    public disconnect(): void {
        this.stopKeepAlive();
        const oldListenKey = this.listenKey;
        this.listenKey = null; // Clear listenKey FIRST so onclose doesn't try to reconnect
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (oldListenKey && this.wsApiClient.isReady()) {
            // Best effort close
            this.wsApiClient.sendRequest("userDataStream.stop", { listenKey: oldListenKey }, 2000, false).catch(() => {});
        }
    }

    public onOrderFilled(cb: (report: ExecutionReport) => void): void {
        this.onOrderFilledCallbacks.push(cb);
    }

    public onOrderCanceled(cb: (report: ExecutionReport) => void): void {
        this.onOrderCanceledCallbacks.push(cb);
    }

    public pushMockReport(report: ExecutionReport): void {
        if (report.orderStatus === "FILLED" || report.orderStatus === "PARTIALLY_FILLED") {
            if (report.executionType === "TRADE") {
                this.onOrderFilledCallbacks.forEach(cb => cb(report));
            }
        } else if (report.orderStatus === "CANCELED" || report.orderStatus === "REJECTED" || report.orderStatus === "EXPIRED") {
            this.onOrderCanceledCallbacks.forEach(cb => cb(report));
        }
    }

    private handleMessage(data: any): void {
        if (data.e === "executionReport") {
            const report: ExecutionReport = {
                symbol: data.s,
                clientOrderId: data.c,
                side: data.S,
                type: data.o,
                timeInForce: data.f,
                originalQty: parseFloat(data.q),
                originalPrice: parseFloat(data.p),
                executionType: data.x,
                orderStatus: data.X,
                orderId: data.i,
                lastFilledQty: parseFloat(data.l),
                accumulatedFilledQty: parseFloat(data.z),
                lastFilledPrice: parseFloat(data.L),
                commissionAsset: data.N,
                commission: parseFloat(data.n),
                tradeTime: data.T
            };

            if (report.orderStatus === "FILLED" || report.orderStatus === "PARTIALLY_FILLED") {
                if (report.executionType === "TRADE") {
                    this.onOrderFilledCallbacks.forEach(cb => cb(report));
                }
            } else if (report.orderStatus === "CANCELED" || report.orderStatus === "REJECTED" || report.orderStatus === "EXPIRED") {
                this.onOrderCanceledCallbacks.forEach(cb => cb(report));
            }
        }
    }

    private startKeepAlive(): void {
        this.stopKeepAlive();
        // Ping listenKey every 30 minutes
        this.keepAliveInterval = setInterval(async () => {
            if (this.listenKey && this.wsApiClient.isReady()) {
                try {
                    await this.wsApiClient.sendRequest("userDataStream.ping", { listenKey: this.listenKey }, 2000, false);
                } catch (err) {
                    console.error("[UserDataStream] Keep-alive failed, reconnecting...");
                    this.disconnect();
                    this.connect().catch(console.error);
                }
            }
        }, 30 * 60 * 1000);
    }

    private stopKeepAlive(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }
}
