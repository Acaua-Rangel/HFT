const start = Date.now();
fetch("https://api.binance.com/api/v3/ping").then(() => {
	console.log(`HTTP Ping RTT: ${Date.now() - start}ms`);
});
