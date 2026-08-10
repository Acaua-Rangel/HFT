import * as fs from 'fs';
import * as path from 'path';

export interface HistoricalTickData {
    timestamp: number;
    price: number;
    volume: number;
}

export class BinanceHistoricalDownloader {
    private readonly dataDir = path.join(__dirname, '../../../../backend/data');

    constructor() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    public async downloadKlinesAsTicks(symbol: string, startTime: number, endTime: number): Promise<HistoricalTickData[]> {
        // Enforce 31 days maximum limit
        const MAX_MS = 31 * 24 * 60 * 60 * 1000;
        if (endTime - startTime > MAX_MS) {
            throw new Error(`Requested period exceeds maximum allowed of 31 days.`);
        }

        const cacheFile = path.join(this.dataDir, `${symbol}_${startTime}_${endTime}.json`);
        
        if (fs.existsSync(cacheFile)) {
            console.log(`📦 Loading historical data from cache: ${cacheFile}`);
            const data = fs.readFileSync(cacheFile, 'utf8');
            return JSON.parse(data);
        }

        console.log(`🌐 Downloading historical 1s klines for ${symbol} from Binance...`);
        const ticks: HistoricalTickData[] = [];
        let currentStart = startTime;
        const LIMIT = 1000;

        while (currentStart < endTime) {
            try {
                const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${currentStart}&endTime=${endTime}&limit=${LIMIT}`;
                const response = await fetch(url);
                
                if (!response.ok) {
                    if (response.status === 429) {
                        console.warn('⚠️ Rate limit hit. Waiting 5 seconds...');
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }
                    throw new Error(`Binance API error: ${response.statusText}`);
                }

                const data = (await response.json()) as any[][];
                
                if (data.length === 0) break;

                for (const kline of data) {
                    const klineTime = kline[0] as number;
                    // Use close price to represent the tick, and volume.
                    // For more fidelity, one could generate 4 ticks (O, H, L, C)
                    // but 1s resolution is already very high.
                    ticks.push({
                        timestamp: klineTime,
                        price: parseFloat(kline[4]), // Close Price
                        volume: parseFloat(kline[5]) // Base Volume
                    });
                }

                currentStart = (data[data.length - 1]![0] as number) + 1000;
                
                // Be nice to the API
                await new Promise(r => setTimeout(r, 100));
                
                process.stdout.write(`\r📥 Downloaded ${ticks.length} ticks...`);

            } catch (err) {
                console.error(`\n❌ Error downloading chunk:`, err);
                break;
            }
        }
        console.log(`\n✅ Download complete. Total ticks: ${ticks.length}`);

        fs.writeFileSync(cacheFile, JSON.stringify(ticks));
        return ticks;
    }
}
