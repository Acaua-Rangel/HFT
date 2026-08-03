import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAIRS = ["SHIBUSDT", "USDTBRL", "SHIBBRL"];
const DAYS = 2;
const DATA_DIR = join(process.cwd(), "data");

if (!existsSync(DATA_DIR)) {
	mkdirSync(DATA_DIR);
}

// Binace API limits to 1000 klines per request
const LIMIT = 1000;
const ONE_SECOND_MS = 1000;
const KLINE_INTERVAL = "1s";

async function fetchKlinesForPair(
	pair: string,
	startTime: number,
	endTime: number,
) {
	const filePath = join(DATA_DIR, `${pair}_2days.json`);
	if (existsSync(filePath)) {
		console.log(`\n⏭️ Skipping ${pair}, data already exists at ${filePath}`);
		return;
	}

	const allKlines: any[] = [];
	let currentStart = startTime;

	console.log(`\n⬇️ Fetching 1s Klines for ${pair} (last ${DAYS} days)...`);

	while (currentStart < endTime) {
		const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${KLINE_INTERVAL}&startTime=${currentStart}&endTime=${endTime}&limit=${LIMIT}`;

		try {
			const response = await fetch(url);
			if (!response.ok) {
				console.error(`HTTP ${response.status} from Binance`);
				await new Promise((r) => setTimeout(r, 1000));
				continue; // Retry
			}

			const data: any[] = (await response.json()) as any[];
			if (data.length === 0) break;

			allKlines.push(...data);

			// The first element of a kline is the openTime
			const lastKlineTime = data[data.length - 1][0];
			currentStart = lastKlineTime + ONE_SECOND_MS;

			// Progress indicator
			process.stdout.write(
				`\r✅ Downloaded ${allKlines.length} klines for ${pair}...`,
			);

			// Small sleep to respect Binance API limits (1200 weight per minute)
			await new Promise((r) => setTimeout(r, 50));
		} catch (e) {
			console.error(e);
			await new Promise((r) => setTimeout(r, 2000));
		}
	}

	console.log(`\n💾 Saving ${allKlines.length} records to disk...`);
	// Save as simplified JSON: [openTime, closePrice]
	const simplified = allKlines.map((k) => ({
		t: k[0], // timestamp
		c: parseFloat(k[4]), // close price
	}));

	writeFileSync(filePath, JSON.stringify(simplified));
}

async function main() {
	const endTime = Date.now();
	const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;

	for (const pair of PAIRS) {
		await fetchKlinesForPair(pair, startTime, endTime);
	}

	console.log("\n🎉 Fetching complete!");
}

main().catch(console.error);
