const ws = new WebSocket("wss://stream.binance.com:9443/ws");
ws.onopen = () => {
	console.log("OPEN");
	ws.send(
		JSON.stringify({
			method: "SUBSCRIBE",
			params: ["btcbrl@bookTicker"],
			id: 1,
		}),
	);
};
let msgCount = 0;
ws.onmessage = (event) => {
	console.log("MESSAGE:", event.data);
	msgCount++;
	if (msgCount > 3) process.exit(0);
};
ws.onerror = (err) => console.log("ERROR:", err);
