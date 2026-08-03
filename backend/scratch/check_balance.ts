import { BinanceWsClient } from "../src/infrastructure/BinanceWsClient";

async function run() {
	const wsClient = new BinanceWsClient("DUMMY", "DUMMY");
	await wsClient.connect();

	setTimeout(async () => {
		try {
			const response = await wsClient.sendRequest("account.status", {});
			console.log(JSON.stringify(response, null, 2));
		} catch (e) {
			console.error(e);
		}
		process.exit(0);
	}, 2000);
}

run();
