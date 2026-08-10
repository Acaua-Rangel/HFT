import { createHmac } from "crypto";

export interface WsRequest {
  id: string;
  method: string;
  params: any;
}

export interface WsResponse {
  id: string;
  status: number;
  result: any;
  error?: any;
}

export class BinanceWsClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, { resolve: (res: any) => void; reject: (err: any) => void; timeout: Timer }>();
  private isConnected = false;
  private isAuthenticated = false;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly url: string = "wss://ws-api.binance.com:443/ws-api/v3"
  ) {}

  public async connect(): Promise<void> {
    if (this.isConnected) return;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.isAuthenticated = true; // For HMAC we authenticate per-request
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const data: WsResponse = JSON.parse(event.data.toString());
          this.handleResponse(data);
        } catch (e) {
          console.error("WS Parse error", e);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.isAuthenticated = false;
        this.rejectAllPending(new Error("WebSocket disconnected unexpectedly"));
      };

      this.ws.onerror = (err) => {
        if (!this.isConnected) {
          reject(err);
        }
      };
    });
  }

  public disconnect(): void {
    if (this.ws) {
      this.ws.close();
    }
  }

  public isReady(): boolean {
    return this.isConnected && this.isAuthenticated;
  }

  private async logon(): Promise<void> {
    // Logon uses Ed25519. For HMAC, we skip logon and sign per-request.
    return;
  }

  public async sendRequest(method: string, params: any, timeoutMs: number = 3000, signed: boolean = true): Promise<WsResponse> {
    if (!this.isReady()) {
      throw new Error("Cannot send request: WebSocket is not authenticated or connected");
    }

    let payloadParams: any = { ...params };
    
    // Always append apiKey if not present
    if (!payloadParams.apiKey) {
        payloadParams.apiKey = this.apiKey;
    }

    if (signed) {
        // Sign the request
        const timestamp = Date.now();
        payloadParams.timestamp = timestamp;
        
        // Sort keys alphabetically for Binance signature
        const sortedKeys = Object.keys(payloadParams).sort();
        const queryString = sortedKeys.map(k => {
          const val = payloadParams[k];
          const stringVal = typeof val === 'object' ? JSON.stringify(val) : val;
          return `${k}=${stringVal}`;
        }).join('&');
        const signature = createHmac("sha256", this.apiSecret).update(queryString).digest("hex");
        
        payloadParams.signature = signature;
    }

    const req: WsRequest = {
      id: crypto.randomUUID(),
      method,
      params: payloadParams
    };

    return this.sendRequestInternal(req, timeoutMs);
  }

  public async ping(timeoutMs: number = 3000): Promise<number> {
    if (!this.isReady()) {
      throw new Error("Cannot send ping: WebSocket is not connected");
    }
    const start = Date.now();
    const req: WsRequest = {
      id: crypto.randomUUID(),
      method: "ping",
      params: {}
    };
    await this.sendRequestInternal(req, timeoutMs);
    return Date.now() - start;
  }

  private sendRequestInternal(req: WsRequest, timeoutMs: number): Promise<WsResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(req.id);
        reject(new Error(`Request ${req.id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(req.id, { resolve, reject, timeout });

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(req));
      } else {
        clearTimeout(timeout);
        this.pendingRequests.delete(req.id);
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  private handleResponse(response: WsResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(response.id);
      pending.resolve(response);
    }
  }

  private rejectAllPending(error: Error): void {
    Array.from(this.pendingRequests.entries()).forEach(([id, pending]) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pendingRequests.clear();
  }
}
