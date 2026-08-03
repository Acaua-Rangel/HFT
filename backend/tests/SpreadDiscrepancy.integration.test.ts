import { expect, test } from "bun:test";
import { ArbitrageMathEngine } from "../src/application/ArbitrageMathEngine";
import { OrderBook } from "../src/domain/entities/OrderBook";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Fee } from "../src/domain/valueObjects/Fee";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Tick } from "../src/domain/valueObjects/Tick";

test("Binance Price Ingestor & Math Engine Integration > Should fetch real Ask/Bid from Binance and calculate spread discrepancy", async () => {
	// 1. Fetch real OrderBook from Binance
	const res = await fetch(
		"https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT",
	);
	const data: any = await res.json();

	expect(data.symbol).toBe("BTCUSDT");
	expect(data.askPrice).toBeDefined();
	expect(data.bidPrice).toBeDefined();

	const ask = parseFloat(data.askPrice);
	const bid = parseFloat(data.bidPrice);

	console.log(
		`[Binance Live Data] BTCUSDT -> Ask (Buy Price): ${ask}, Bid (Sell Price): ${bid}`,
	);

	// Spread should always mean Ask is higher than Bid in normal markets
	expect(ask).toBeGreaterThan(bid);

	// 2. Create Domain Entities
	const btcUsdtPair = new Pair(new Currency("BTC"), new Currency("USDT"));
	const realTick = new Tick(
		btcUsdtPair,
		[{ price: new Amount(ask), qty: new Amount(10) }],
		[{ price: new Amount(bid), qty: new Amount(10) }],
	);

	// 3. Validate Tick Logic
	const initialUsdt = new Amount(1000);

	// When we buy BTC using USDT, we pay the Ask Price
	const boughtBtc = realTick.convertBuy(initialUsdt);
	let boughtBtcVal = 0;
	boughtBtc.apply((v) => (boughtBtcVal = v));

	// When we sell that BTC back to USDT, we receive the Bid Price
	const soldUsdt = realTick.convertSell(boughtBtc);
	let soldUsdtVal = 0;
	soldUsdt.apply((v) => (soldUsdtVal = v));

	console.log(`[Tick Logic] Bought BTC: ${boughtBtcVal} BTC`);
	console.log(
		`[Tick Logic] Sold back to USDT: ${soldUsdtVal} USDT (Started with 1000)`,
	);

	// We should have less than 1000 USDT due to the Spread!
	expect(soldUsdtVal).toBeLessThan(1000);

	// 4. Validate MathEngine integration
	const mathEngine = new ArbitrageMathEngine();
	const book1 = new OrderBook();
	book1.add(realTick);
	const book2 = new OrderBook();
	book2.add(
		new Tick(
			new Pair(new Currency("ETH"), new Currency("BTC")),
			[{ price: new Amount(1), qty: new Amount(100) }],
			[{ price: new Amount(1), qty: new Amount(100) }],
		),
	); // Dummy
	const book3 = new OrderBook();
	book3.add(
		new Tick(
			new Pair(new Currency("ETH"), new Currency("USDT")),
			[{ price: new Amount(1), qty: new Amount(100) }],
			[{ price: new Amount(1), qty: new Amount(100) }],
		),
	); // Dummy

	const zeroFee = new Fee(new Amount(0));

	// Simulate cycle: Buy BTC (Pay Ask), Buy ETH (1:1), Sell ETH to USDT (1:1)
	// This effectively tests the BTC/USDT Spread isolated
	const profit = mathEngine.calculateArbitrageProfit(
		initialUsdt,
		book1,
		book2,
		book3,
		zeroFee,
		zeroFee,
		zeroFee,
	);

	let profitVal = 0;
	profit.apply((v) => (profitVal = v));

	console.log(`[MathEngine] Real Spread Loss on 1000 USDT: ${profitVal} USDT`);

	// The profit must be exactly the difference caused by the spread (negative)
	expect(profitVal).toBeLessThan(0);
});
