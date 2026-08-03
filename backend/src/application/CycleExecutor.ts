import type { OrderExecutor } from "../domain/interfaces/OrderExecutor";
import { Amount } from "../domain/valueObjects/Amount";
import { OrderFill } from "../domain/valueObjects/OrderFill";
import type { Pair } from "../domain/valueObjects/Pair";
import {
	ErrorContext,
	ErrorLogEntry,
	type ErrorLogRepository,
	ErrorMessage,
	ErrorType,
	StackTrace,
} from "../infrastructure/database/ErrorLogRepository";
import type { TransactionRepository } from "../infrastructure/database/TransactionRepository";
import type { TriangularPairs } from "./TriangularPairs";

export class CycleExecutor {
	private dustMap = new Map<string, number>();

	constructor(
		private readonly executorProvider: () => OrderExecutor,
		private readonly errorRepo: ErrorLogRepository,
		readonly _transactionRepo: TransactionRepository,
	) {}

	public initializeDust(balances: Map<string, number>): void {
		this.dustMap = balances;
		console.log(
			`🧹 Dust Sweeper initialized with ${balances.size} assets from Spot Wallet.`,
		);
	}

	public async executeCycle(
		pairs: TriangularPairs,
		initialAmount: Amount,
		_fee1?: any,
		_fee2?: any,
	): Promise<OrderFill> {
		let finalFill = OrderFill.failed();
		const executor = this.executorProvider();

		if (!executor.canExecuteBatch(3)) {
			return OrderFill.failed();
		}

		await pairs.applyAsync(async (first: Pair, second: Pair, third: Pair) => {
			try {
				const fill1 = await this.executeWithTimeout(
					() => executor.executeMarketBuy(first, initialAmount),
					5000,
				);

				let isSuccess1 = false;
				let qty1 = new Amount(0);
				fill1.apply((q, _quote, _p, s) => {
					isSuccess1 = s;
					qty1 = q;
				});
				if (!isSuccess1) {
					finalFill = OrderFill.failed();
					return;
				}

				let firstBaseSym = "";
				first.applyCurrencies((base) =>
					base.applySymbol((s) => (firstBaseSym = s.toUpperCase())),
				);

				let qty1Val = 0;
				qty1.apply((v) => (qty1Val = v));

				// Sweeps dust from RAM
				const existingDust1 = this.dustMap.get(firstBaseSym) || 0;
				const totalQty1 = qty1Val + existingDust1;
				const safeQty1 = new Amount(totalQty1);

				let isSuccess2 = false;
				let qty2 = new Amount(0);
				let quote2 = new Amount(0); // This is what we actually spent

				const fill2 = await this.executeWithTimeout(
					() => executor.executeMarketBuy(second, safeQty1),
					5000,
				);

				fill2.apply((q, quote, _p, s) => {
					isSuccess2 = s;
					qty2 = q;
					quote2 = quote;
				});

				if (!isSuccess2) {
					await this.handleBrokenLeg(executor, first, safeQty1, "Leg 2 failed");
					finalFill = OrderFill.failed();
					return;
				}

				// Save remainder dust back to RAM
				let quote2Val = 0;
				quote2.apply((v) => (quote2Val = v));
				this.dustMap.set(firstBaseSym, Math.max(0, totalQty1 - quote2Val));

				let secondBaseSym = "";
				second.applyCurrencies((base) =>
					base.applySymbol((s) => (secondBaseSym = s.toUpperCase())),
				);

				let qty2Val = 0;
				qty2.apply((v) => (qty2Val = v));

				const existingDust2 = this.dustMap.get(secondBaseSym) || 0;
				const totalQty2 = qty2Val + existingDust2;
				const safeQty2 = new Amount(totalQty2);

				let isSuccess3 = false;
				let qty3 = new Amount(0);

				const fill3 = await this.executeWithTimeout(
					() => executor.executeMarketSell(third, safeQty2),
					5000,
				);

				fill3.apply((q, _quote, _p, s) => {
					isSuccess3 = s;
					qty3 = q;
				});

				if (!isSuccess3) {
					await this.handleBrokenLeg(
						executor,
						second,
						safeQty2,
						"Leg 3 failed",
					);
					finalFill = OrderFill.failed();
					return;
				}

				let qty3Val = 0;
				qty3.apply((v) => (qty3Val = v));
				this.dustMap.set(secondBaseSym, Math.max(0, totalQty2 - qty3Val));

				finalFill = fill3;
			} catch (_err) {
				finalFill = OrderFill.failed();
			}
		});

		return finalFill;
	}

	private async executeWithTimeout(
		operation: () => Promise<OrderFill>,
		timeoutMs: number,
	): Promise<OrderFill> {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				resolve(OrderFill.failed());
			}, timeoutMs);

			operation()
				.then((res) => {
					clearTimeout(timeout);
					resolve(res);
				})
				.catch(() => {
					clearTimeout(timeout);
					resolve(OrderFill.failed());
				});
		});
	}

	private async handleBrokenLeg(
		executor: OrderExecutor,
		pairToRevert: Pair,
		amount: Amount,
		reason: string,
	): Promise<void> {
		try {
			await executor.executeMarketSell(pairToRevert, amount);
		} catch (e) {
			reason += ` (Revert also failed)`;
		}

		let symbolStr = "";
		pairToRevert.applyBinanceSymbol((s) => (symbolStr = s));

		let amountVal = 0;
		amount.apply((v) => (amountVal = v));

		const entry = new ErrorLogEntry(
			{ asString: () => crypto.randomUUID() } as any,
			{ asNumber: () => Date.now() } as any,
			new ErrorType("BROKEN_LEG"),
			new ErrorMessage(`Protection triggered for ${symbolStr}: ${reason}`),
			new StackTrace(null),
			new ErrorContext(JSON.stringify({ amount: amountVal })),
		);
		this.errorRepo.save(entry);
	}
}
