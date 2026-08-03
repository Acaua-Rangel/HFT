import { Amount } from "../domain/valueObjects/Amount";
import type { Currency } from "../domain/valueObjects/Currency";

export class VirtualBalanceManager {
	private balances: Map<string, Amount>;

	constructor(initialBrlBalance: Amount) {
		this.balances = new Map<string, Amount>();
		this.balances.set("BRL", initialBrlBalance);
	}

	public debit(currency: Currency, amount: Amount): void {
		currency.applySymbol((symbol) => {
			const current = this.getBalanceForSymbol(symbol);
			this.balances.set(symbol, current.subtract(amount));
		});
	}

	public credit(currency: Currency, amount: Amount): void {
		currency.applySymbol((symbol) => {
			const current = this.getBalanceForSymbol(symbol);
			this.balances.set(symbol, current.add(amount));
		});
	}

	public getBalance(currency: Currency): Amount {
		let result = new Amount(0);
		currency.applySymbol((symbol) => {
			result = this.getBalanceForSymbol(symbol);
		});
		return result;
	}

	public applyAllBalances(
		callback: (balances: Map<string, number>) => void,
	): void {
		const rawBalances = new Map<string, number>();
		this.balances.forEach((amount, symbol) => {
			amount.apply((val) => {
				rawBalances.set(symbol, val);
			});
		});
		callback(rawBalances);
	}

	private getBalanceForSymbol(symbol: string): Amount {
		const balance = this.balances.get(symbol);
		const hasBalance = balance !== undefined;
		if (hasBalance) {
			return balance;
		}
		return new Amount(0);
	}
}
