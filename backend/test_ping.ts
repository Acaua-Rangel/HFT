const start = Date.now();
const ws = new WebSocket("wss://ws-api.binance.com:443/ws-api/v3");
ws.onopen = () => {
    const connectTime = Date.now() - start;
    console.log(`Connected in ${connectTime}ms`);
    const pingStart = Date.now();
    ws.send(JSON.stringify({ id: "ping-1", method: "ping" }));
    ws.onmessage = (msg) => {
        const pingTime = Date.now() - pingStart;
        console.log(`Ping response in ${pingTime}ms`, msg.data);
        ws.close();
    }
}
