import { Amount } from "./Amount";

export class OrderFill {
	constructor(
		private readonly filledQuantity: Amount,
		private readonly filledQuote: Amount,
		private readonly averagePrice: Amount,
		private readonly success: boolean,
	) {}

	public static failed(): OrderFill {
		return new OrderFill(new Amount(0), new Amount(0), new Amount(0), false);
	}

	public apply(
		callback: (
			filledQuantity: Amount,
			filledQuote: Amount,
			averagePrice: Amount,
			success: boolean,
		) => void,
	): void {
		callback(
			this.filledQuantity,
			this.filledQuote,
			this.averagePrice,
			this.success,
		);
	}
}
