import { Amount } from "../domain/valueObjects/Amount";
import { BinanceWsClient } from "./BinanceWsClient";

export class BinanceBalanceFetcher {
  private hasLoggedWarning = false;

  constructor(private readonly wsClient: BinanceWsClient) {}

  public async fetchBalances(): Promise<Map<string, Amount>> {
    if (!this.wsClient.isReady()) {
      return new Map<string, Amount>();
    }

    try {
      const response = await this.wsClient.sendRequest("account.status", {});
      
      const isOk = response.status === 200;
      if (!isOk) {
        if (!this.hasLoggedWarning) {
          console.error(`❌ WS Error when fetching balance: ${JSON.stringify(response.error)}`);
          this.hasLoggedWarning = true;
        }
        return new Map<string, Amount>();
      }

      this.hasLoggedWarning = false;
      const data = response.result;
      const balancesMap = new Map<string, Amount>();

      if (Array.isArray(data.balances)) {
         for (const b of data.balances) {
           const asset = b.asset;
           const freeVal = parseFloat(b.free || "0");
           const lockedVal = parseFloat(b.locked || "0");
           const totalVal = freeVal + lockedVal;
           if (totalVal > 0) {
             balancesMap.set(asset, new Amount(totalVal));
           }
         }
      }
      
      return balancesMap;
    } catch (e) {
      if (!this.hasLoggedWarning) {
        console.error("❌ Failed to fetch balance via WebSocket", e);
        this.hasLoggedWarning = true;
      }
      return new Map<string, Amount>();
    }
  }
}
