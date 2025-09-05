export abstract class Module {

	constructor(public readonly name: string) {
	}

	public onPacket?(packet: Packets.PacketEvent): unknown | Promise<unknown>;

	/** Called once the bot entity is ready (after queue if applicable). Override to initialize. */
	public onReady?(): void;

	/** Called every game tick (50ms) from the physics loop. */
	public onTick?(): void;
    
}