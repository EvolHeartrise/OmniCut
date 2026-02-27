/**
 * Generic sequential FIFO queue — one active job at a time.
 * Subclasses provide the job execution logic via the `run` callback.
 */

export class SequentialQueue {
	private queue: string[] = [];
	private activeId: string | null = null;
	private readonly run: (id: string) => Promise<void>;

	constructor(run: (id: string) => Promise<void>) {
		this.run = run;
	}

	/** Whether a job is currently running. */
	get active(): string | null {
		return this.activeId;
	}

	/** Add an ID to the queue and start processing if idle. */
	enqueue(id: string): void {
		this.queue.push(id);
		this.process();
	}

	/** Remove an ID from the pending queue (no-op if not found or active). */
	dequeue(id: string): void {
		const idx = this.queue.indexOf(id);
		if (idx !== -1) this.queue.splice(idx, 1);
	}

	/** Check if an ID is currently active. */
	isActive(id: string): boolean {
		return this.activeId === id;
	}

	/** Clear all pending items and reset the active flag. */
	shutdown(): void {
		this.activeId = null;
		this.queue.length = 0;
	}

	private process(): void {
		if (this.activeId || this.queue.length === 0) return;
		const id = this.queue.shift()!;
		this.activeId = id;
		this.run(id).finally(() => {
			this.activeId = null;
			this.process();
		});
	}
}
