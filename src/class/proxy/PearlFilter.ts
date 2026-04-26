import type { Client as MinecraftClient } from "minecraft-protocol";

/**
 * Hides pearl entities for which a hologram is actively rendering a visual.
 *
 * The bridge consults {@link PearlFilter.isHidden} for every entity-bearing
 * packet (and {@link PearlFilter.hide} is called by the hologram once a fake
 * entity has been spawned) so the underlying real pearl never appears
 * client-side. Pearls without a hologram visual (e.g. unsaved/unregistered
 * stasis chambers, or pearls in stasis whose chamber has no
 * {@link StasisColumn}) remain visible — only registered/saved chambers are
 * hidden.
 */
export class PearlFilter {

	constructor(
		private readonly client: MinecraftClient,
		private readonly _isHidden: (entityId: number) => boolean
	) {}

	/**
	 * Whether the given entity ID belongs to a pearl currently rendered by the
	 * hologram (and therefore must be hidden from the bridge).
	 */
	public isHidden(entityId: number): boolean {
		return this._isHidden(entityId);
	}

	/**
	 * Send a synthetic `entity_destroy` to the client so the underlying real
	 * pearl entity disappears the instant the hologram takes over. Called by
	 * {@link TextHologram} via its `onTracked` callback.
	 */
	public hide(entityId: number) {
		try {
			this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", {
				name: "entity_destroy",
				params: { entityIds: [ entityId ] }
			}));
		} catch { /* client may have disconnected */ }
	}

}
