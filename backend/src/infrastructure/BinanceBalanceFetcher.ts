import { Amount } from "../domain/valueObjects/Amount";
import { BinanceWsClient } from "./BinanceWsClient";

export class BinanceBalanceFetcher {
  private hasLoggedWarning = false;

  constructor(private readonly wsClient: BinanceWsClient) {}

  public async fetchBalances(): Promise<{ brl: Amount, bnb: Amount, dust: Map<string, number> }> {
    if (!this.wsClient.isReady()) {
      return { brl: new Amount(0), bnb: new Amount(0), dust: new Map() };
    }

    try {
      const response = await this.wsClient.sendRequest("account.status", {});
      
      const isOk = response.status === 200;
      if (!isOk) {
        if (!this.hasLoggedWarning) {
          console.error(`❌ WS Error when fetching balance: ${JSON.stringify(response.error)}`);
          this.hasLoggedWarning = true;
        }
        return { brl: new Amount(0), bnb: new Amount(0), dust: new Map() };
      }

      this.hasLoggedWarning = false;
      const data = response.result;
      const brlBalance = data.balances?.find((b: any) => b.asset === "BRL");
      const bnbBalance = data.balances?.find((b: any) => b.asset === "BNB");
      
      let brlAmount = new Amount(0);
      let bnbAmount = new Amount(0);

      if (brlBalance !== undefined) {
        brlAmount = new Amount(parseFloat(brlBalance.free));
      }
      if (bnbBalance !== undefined) {
        bnbAmount = new Amount(parseFloat(bnbBalance.free));
      }

      const dustMap = new Map<string, number>();
      if (Array.isArray(data.balances)) {
        for (const b of data.balances) {
           const asset = b.asset;
           if (asset !== "BRL" && asset !== "BNB") {
             const freeVal = parseFloat(b.free);
             if (freeVal > 0) {
               dustMap.set(asset, freeVal);
             }
           }
        }
      }
      
      return { brl: brlAmount, bnb: bnbAmount, dust: dustMap };
    } catch (e) {
      if (!this.hasLoggedWarning) {
        console.error("❌ Failed to fetch balance via WebSocket", e);
        this.hasLoggedWarning = true;
      }
      return { brl: new Amount(0), bnb: new Amount(0), dust: new Map() };
    }
  }
}
