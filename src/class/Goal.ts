import { EventEmitter } from "events";

export class Goal extends EventEmitter<{

	arrived: [];

	timeout: [];

	cancelled: [];

}> {

	public range = 4;
	public timeout: number | null = null;

	/** @internal */ _timer: ReturnType<typeof setTimeout> | null = null;

	constructor(public readonly position: Vec3Like) {
		super();
	}

	public setRange(range: number): this {
		this.range = range;
		return this;
	}

	public setTimeout(ms: number): this {
		this.timeout = ms;
		return this;
	}
}
