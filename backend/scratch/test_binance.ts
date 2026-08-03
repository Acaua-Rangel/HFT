import * as crypto from "node:crypto";

async function testBinanceApi() {
	const key = (process.env.BINANCE_API_KEY || "").trim();
	const secret = (process.env.BINANCE_API_SECRET || "").trim();

	const timestamp = Date.now();

	const feeQuery = `symbol=BTCBRL&timestamp=${timestamp}`;
	const feeSig = crypto
		.createHmac("sha256", secret)
		.update(feeQuery)
		.digest("hex");
	const feeUrl = `https://api.binance.com/sapi/v1/asset/tradeFee?${feeQuery}&signature=${feeSig}`;

	console.log(`\nFetching Fee from sapi: ${feeUrl}`);
	const feeRes = await fetch(feeUrl, {
		method: "GET",
		headers: { "X-MBX-APIKEY": key },
	});
	console.log(`Fee Status: ${feeRes.status}`);
	console.log(`Fee Response: ${await feeRes.text()}`);
}

testBinanceApi();
