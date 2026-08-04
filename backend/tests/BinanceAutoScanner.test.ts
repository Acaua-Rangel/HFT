import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { BinanceAutoScanner } from "../src/infrastructure/BinanceAutoScanner";

describe("BinanceAutoScanner", () => {
    let globalFetch: any;

    beforeEach(() => {
        globalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = globalFetch;
    });

    it("should scan and return triangles correctly", async () => {
        global.fetch = mock(async (url: string) => {
            if (url.includes("exchangeInfo")) {
                return {
                    ok: true,
                    json: async () => ({
                        symbols: [
                            { status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT" },
                            { status: "TRADING", baseAsset: "BTC", quoteAsset: "BRL" },
                            { status: "TRADING", baseAsset: "ETH", quoteAsset: "USDT" },
                            { status: "TRADING", baseAsset: "ETH", quoteAsset: "BRL" },
                            // Missing pair
                            { status: "TRADING", baseAsset: "XRP", quoteAsset: "USDT" },
                            // Stablecoin (will be filtered out)
                            { status: "TRADING", baseAsset: "FDUSD", quoteAsset: "USDT" },
                            { status: "TRADING", baseAsset: "FDUSD", quoteAsset: "BRL" }
                        ]
                    })
                };
            }
            if (url.includes("ticker/price")) {
                return {
                    ok: true,
                    json: async () => ([
                        { symbol: "BTCUSDT", price: "60000" },
                        { symbol: "ETHUSDT", price: "3000" },
                        { symbol: "FDUSDUSDT", price: "0.999" }
                    ])
                };
            }
        }) as any;

        const scanner = new BinanceAutoScanner();
        const triangles = await scanner.scanTriangles("USDT", "BRL");

        // Should return BTC and ETH triangles, but exclude FDUSD (stablecoin peg detection)
        expect(triangles.length).toBe(2);

        let btcFound = false;
        let ethFound = false;

        triangles.forEach(t => {
            let sym = "";
            t.third.applyBinanceSymbol(s => sym = s);
            if (sym === "BTCBRL") btcFound = true;
            if (sym === "ETHBRL") ethFound = true;
        });

        expect(btcFound).toBe(true);
        expect(ethFound).toBe(true);
    });

    it("should return empty array on exchangeInfo fetch failure", async () => {
        global.fetch = mock(async (url: string) => {
            return { ok: false, status: 500 };
        }) as any;

        const scanner = new BinanceAutoScanner();
        const triangles = await scanner.scanTriangles("USDT", "BRL");
        expect(triangles.length).toBe(0);
    });

    it("should return empty array on exception", async () => {
        global.fetch = mock(async () => {
            throw new Error("Network error");
        }) as any;

        const scanner = new BinanceAutoScanner();
        const triangles = await scanner.scanTriangles("USDT", "BRL");
        expect(triangles.length).toBe(0);
    });
});
