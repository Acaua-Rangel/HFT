export class ExecutionLock {
	private isLocked = false;

	public acquire(): boolean {
		if (this.isLocked) {
			return false;
		}
		this.isLocked = true;
		return true;
	}

	public release(): void {
		this.isLocked = false;
	}

	public async runIfUnlocked(block: () => Promise<void>): Promise<void> {
		if (!this.acquire()) {
			return;
		}
		try {
			await block();
		} finally {
			this.release();
		}
	}

	public isCurrentlyLocked(): boolean {
		return this.isLocked;
	}
}
