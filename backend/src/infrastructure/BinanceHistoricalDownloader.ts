import * as fs from 'fs';
import * as path from 'path';

export interface HistoricalTickData {
    timestamp: number;
    /** Preço de fechamento da barra. */
    price: number;
    /** Volume em unidades do ativo base. */
    volume: number;
    /** Máxima da barra. Sem ela, varreduras intrabar ficam invisíveis. */
    high: number;
    /** Mínima da barra. */
    low: number;
    open: number;
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

        // v2: o cache v1 guardava apenas close+volume. Reaproveitá-lo deixaria high/low
        // como undefined e o simulador cairia silenciosamente no modelo antigo.
        const cacheFile = path.join(this.dataDir, `${symbol}_${startTime}_${endTime}_v2.json`);
        
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
                    // O/H/L/C completos. Usar só o close esconde toda varredura intrabar:
                    // uma ordem de compra a P é executada se o preço NEGOCIOU abaixo de P
                    // dentro da barra, mesmo que tenha fechado acima.
                    ticks.push({
                        timestamp: klineTime,
                        open: parseFloat(kline[1]),
                        high: parseFloat(kline[2]),
                        low: parseFloat(kline[3]),
                        price: parseFloat(kline[4]),
                        volume: parseFloat(kline[5])
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
