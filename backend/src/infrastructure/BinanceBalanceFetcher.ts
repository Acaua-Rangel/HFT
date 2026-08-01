import { Amount } from "../domain/valueObjects/Amount";
import { BinanceWsClient } from "./BinanceWsClient";

export class BinanceBalanceFetcher {
  private hasLoggedWarning = false;

  constructor(private readonly wsClient: BinanceWsClient) {}

  public async fetchBrlBalance(): Promise<Amount> {
    if (!this.wsClient.isReady()) {
      return new Amount(0);
    }

    try {
      const response = await this.wsClient.sendRequest("account.status", {});
      
      const isOk = response.status === 200;
      if (!isOk) {
        if (!this.hasLoggedWarning) {
          console.error(`❌ WS Error when fetching balance: ${JSON.stringify(response.error)}`);
          this.hasLoggedWarning = true;
        }
        return new Amount(0);
      }

      this.hasLoggedWarning = false;
      const data = response.result;
      const brlBalance = data.balances?.find((b: any) => b.asset === "BRL");
      
      const hasBalance = brlBalance !== undefined;
      if (hasBalance) {
        const freeAmount = parseFloat(brlBalance.free);
        return new Amount(freeAmount);
      }
      return new Amount(0);
    } catch (e) {
      if (!this.hasLoggedWarning) {
        console.error("❌ Failed to fetch balance via WebSocket", e);
        this.hasLoggedWarning = true;
      }
      return new Amount(0);
    }
  }
}
