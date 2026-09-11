/**
 * The queue itself: an ordered list of prompts the user has written but not yet
 * sent, plus the one prompt currently on its way to the agent. Pi-free.
 */

/** An image attached to a prompt — the shape of pi-ai's `ImageContent`. */
export interface QueuedImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface QueuedPrompt {
	/** Stable id, 1-based and monotonic within the session; never reused. */
	id: number;
	text: string;
	images?: QueuedImage[];
	queuedAt: number;
}

/** The queued prompt handed to the agent, and how far it got. */
export interface InFlight extends QueuedPrompt {
	sentAt: number;
	/** Set once pi confirms it took the message (an `input` echo or `agent_start`). */
	started: boolean;
}

export class PromptQueue {
	private items: QueuedPrompt[] = [];
	private nextId = 1;
	/** While held, nothing leaves the queue. */
	held = false;
	inFlight: InFlight | undefined = undefined;

	get size(): number {
		return this.items.length;
	}

	list(): readonly QueuedPrompt[] {
		return this.items;
	}

	/** Append. Empty or whitespace-only text is refused. */
	push(text: string, images?: QueuedImage[], now = Date.now()): QueuedPrompt | undefined {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const item: QueuedPrompt = { id: this.nextId++, text: trimmed, queuedAt: now };
		if (images && images.length > 0) item.images = images;
		this.items.push(item);
		return item;
	}

	/** Remove the prompt at a 1-based position, as the widget numbers them. */
	drop(position: number): QueuedPrompt | undefined {
		if (!Number.isInteger(position) || position < 1 || position > this.items.length) return undefined;
		return this.items.splice(position - 1, 1)[0];
	}

	/** Remove and return the newest prompt. */
	pop(): QueuedPrompt | undefined {
		return this.items.pop();
	}

	/** Empty the queue and return what was in it, in order. */
	clear(): QueuedPrompt[] {
		const gone = this.items;
		this.items = [];
		return gone;
	}

	/** Take the head as the prompt now being sent; it stays as `inFlight` until a run starts. */
	takeForSend(now = Date.now()): InFlight | undefined {
		const item = this.items.shift();
		if (!item) return undefined;
		this.inFlight = { ...item, sentAt: now, started: false };
		return this.inFlight;
	}

	markStarted(): void {
		if (this.inFlight) this.inFlight.started = true;
	}

	clearInFlight(): void {
		this.inFlight = undefined;
	}

	/** Return the in-flight prompt to the head of the queue (pi refused the send). */
	requeueInFlight(): QueuedPrompt | undefined {
		const item = this.inFlight;
		if (!item) return undefined;
		this.inFlight = undefined;
		const { sentAt: _sentAt, started: _started, ...plain } = item;
		this.items.unshift(plain);
		return plain;
	}
}

/** The one line a multi-line prompt is shown as: its first non-blank line plus a count of the rest. */
export function summarize(text: string): { line: string; more: number } {
	const lines = text.split(/\r?\n/);
	const first = lines.findIndex((l) => l.trim() !== "");
	if (first === -1) return { line: "", more: 0 };
	const rest = lines.slice(first + 1).filter((l) => l.trim() !== "").length;
	return { line: lines[first].trim().replace(/\s+/g, " "), more: rest };
}
