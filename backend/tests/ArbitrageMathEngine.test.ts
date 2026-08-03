import { describe, expect, it } from "bun:test";
import { ArbitrageMathEngine } from "../src/application/ArbitrageMathEngine";
import { OrderBook } from "../src/domain/entities/OrderBook";
import { Amount } from "../src/domain/valueObjects/Amount";
import { Currency } from "../src/domain/valueObjects/Currency";
import { Fee } from "../src/domain/valueObjects/Fee";
import { Pair } from "../src/domain/valueObjects/Pair";
import { Tick } from "../src/domain/valueObjects/Tick";

describe("ArbitrageMathEngine", () => {
	it("should calculate profit correctly", () => {
		const engine = new ArbitrageMathEngine();
		const initialBrl = new Amount(1000);
		const fee = new Fee(new Amount(0.001)); // 0.1%

		const btcBrlBook = new OrderBook();
		btcBrlBook.add(
			new Tick(
				new Pair(new Currency("BTC"), new Currency("BRL")),
				[{ price: new Amount(100000), qty: new Amount(10) }],
				[{ price: new Amount(100000), qty: new Amount(10) }],
			),
		);
		const ethBtcBook = new OrderBook();
		ethBtcBook.add(
			new Tick(
				new Pair(new Currency("ETH"), new Currency("BTC")),
				[{ price: new Amount(0.05), qty: new Amount(100) }],
				[{ price: new Amount(0.05), qty: new Amount(100) }],
			),
		);
		const ethBrlBook = new OrderBook();
		ethBrlBook.add(
			new Tick(
				new Pair(new Currency("ETH"), new Currency("BRL")),
				[{ price: new Amount(6000), qty: new Amount(100) }],
				[{ price: new Amount(6000), qty: new Amount(100) }],
			),
		);

		// 1. Buy BTC with BRL
		// 1000 / 100000 = 0.01 BTC
		// Fee: 0.1% of 0.01 = 0.00001 BTC
		// After fee: 0.00999 BTC

		// 2. Buy ETH with BTC
		// 0.00999 / 0.05 = 0.1998 ETH
		// Fee: 0.1% of 0.1998 = 0.0001998 ETH
		// After fee: 0.1996002 ETH

		// 3. Sell ETH for BRL
		// 0.1996002 * 6000 = 1197.6012 BRL
		// Fee: 0.1% of 1197.6012 = 1.1976 BRL
		// Final BRL: 1196.4036 BRL
		// Profit: 1196.4036 - 1000 = 196.4036 BRL

		const profit = engine.calculateArbitrageProfit(
			initialBrl,
			btcBrlBook,
			ethBtcBook,
			ethBrlBook,
			fee,
			fee,
			fee,
		);

		// We expect a profit around 196.40 (accounting for precision)
		expect((profit as any).value).toBeCloseTo(196.4, 2);
	});

	it("should return zero profit if missing orderbook data", () => {
		const engine = new ArbitrageMathEngine();
		const initialBrl = new Amount(1000);
		const fee = new Fee(new Amount(0.001));

		const btcBrlBook = new OrderBook();
		const ethBtcBook = new OrderBook();
		const ethBrlBook = new OrderBook();

		const profit = engine.calculateArbitrageProfit(
			initialBrl,
			btcBrlBook,
			ethBtcBook,
			ethBrlBook,
			fee,
			fee,
			fee,
		);
		expect((profit as any).value).toBe(-9999999);
	});

	it("should return zero profit if missing orderbook data in helper methods", () => {
		const engine = new ArbitrageMathEngine();

		// Empty bids/asks for first leg
		const emptyTick = new Tick(
			new Pair(new Currency("BTC"), new Currency("USDT")),
			[],
			[],
		);

		const fee = new Fee(new Amount(0.001));
		const amount = new Amount(100);

		const profit1 = engine.calculateFirstLeg(emptyTick, fee, amount, true);
		const profit2 = engine.calculateSecondLeg(emptyTick, fee, amount, true);
		const profit3 = engine.calculateThirdLeg(emptyTick, fee, amount, true);

		let pnl1 = -1;
		let pnl2 = -1;
		let pnl3 = -1;
		(profit1 as any).apply((v: number) => (pnl1 = v));
		(profit2 as any).apply((v: number) => (pnl2 = v));
		(profit3 as any).apply((v: number) => (pnl3 = v));

		expect(pnl1).toBeLessThan(0);
		expect(pnl2).toBeLessThan(0);
		expect(pnl3).toBeLessThan(0);
	});

	it("should calculate profit correctly when BNB fee is used", () => {
		const engine = new ArbitrageMathEngine();
		const initialBrl = new Amount(1000);
		const standardFee = new Fee(new Amount(0.001)); // 0.1%
		const bnbFee = standardFee.withBnbDiscount(); // 0.075%

		const btcBrlBook = new OrderBook();
		btcBrlBook.add(
			new Tick(
				new Pair(new Currency("BTC"), new Currency("BRL")),
				[{ price: new Amount(100000), qty: new Amount(10) }],
				[{ price: new Amount(100000), qty: new Amount(10) }],
			),
		);
		const ethBtcBook = new OrderBook();
		ethBtcBook.add(
			new Tick(
				new Pair(new Currency("ETH"), new Currency("BTC")),
				[{ price: new Amount(0.05), qty: new Amount(100) }],
				[{ price: new Amount(0.05), qty: new Amount(100) }],
			),
		);
		const ethBrlBook = new OrderBook();
		ethBrlBook.add(
			new Tick(
				new Pair(new Currency("ETH"), new Currency("BRL")),
				[{ price: new Amount(6000), qty: new Amount(100) }],
				[{ price: new Amount(6000), qty: new Amount(100) }],
			),
		);

		// Se pago com BNB, não há dedução nas pernas:
		// 1. Buy BTC: 1000 / 100000 = 0.01 BTC
		// 2. Buy ETH: 0.01 / 0.05 = 0.2 ETH
		// 3. Sell ETH: 0.2 * 6000 = 1200 BRL
		// Lucro bruto: 1200 - 1000 = 200 BRL

		// Desconto do BNB em BRL:
		// Taxa total = 0.075% + 0.075% + 0.075% = 0.225%
		// 0.225% de 1000 = 2.25 BRL
		// Lucro líquido real: 200 - 2.25 = 197.75 BRL

		const profit = engine.calculateArbitrageProfit(
			initialBrl,
			btcBrlBook,
			ethBtcBook,
			ethBrlBook,
			bnbFee,
			bnbFee,
			bnbFee,
		);

		expect((profit as any).value).toBeCloseTo(197.75, 2);
	});
});
