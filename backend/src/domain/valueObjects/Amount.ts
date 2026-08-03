export class Amount {
	constructor(private readonly value: number) {}

	public add(other: Amount): Amount {
		return new Amount(this.value + other.value);
	}

	public subtract(other: Amount): Amount {
		return new Amount(this.value - other.value);
	}

	public multiplyBy(factor: Amount): Amount {
		return new Amount(this.value * factor.value);
	}

	public divideBy(divisor: Amount): Amount {
		return new Amount(this.value / divisor.value);
	}

	public isGreaterThan(other: Amount): boolean {
		return this.value > other.value;
	}

	public apply(callback: (value: number) => void): void {
		callback(this.value);
	}
}
