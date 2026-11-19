declare namespace Packets {

	type PacketEvent<K extends keyof Schema = keyof Schema> =
		K extends K ? { name: K; data: Schema[K] } : never;

	interface Schema {

		"spawn_entity": {
			entityId: number;
			objectUUID: string;
			type: number;
			x: number;
			y: number;
			z: number;
			pitch: number;
			yaw: number;
			headPitch: number;
			objectData: number;
			velocity: {
				x: number;
				y: number;
				z: number;
			},
		},

		/** Text components are tagged NBT since 1.20.3 — parse with `ChatManager.fromWire`. */
		"set_title_text": {
			text: unknown;
		},

		"set_title_subtitle": {
			text: unknown;
		}

		"update_health": {
			health: number;
			food: number;
			foodSaturation: number;
		}

		"entity_metadata": {
			entityId: number;
			metadata: {
				key: number;
				type: number;
				value: unknown;
			}[];
		}

		"entity_status": {
			entityId: number;
			entityStatus: number;
		}

		/** Since 1.20.5 the spawn data shared with `login` is nested under `worldState`. */
		"respawn": {
			worldState: {

				/** Index into the dimension_type registry sent during configuration. */
				dimension: number;
				name: string;
				hashedSeed: bigint;
				gamemode: "survival" | "creative" | "adventure" | "spectator";
				previousGamemode: number;
				isDebug: boolean;
				isFlat: boolean;
				death?: {
					dimensionName: string;
					location: { x: number; y: number; z: number };
				};
				portalCooldown: number;
			};

			/** Bit 0x01 keeps attributes, 0x02 keeps entity metadata. */
			copyMetadata: number;
		}

		"entity_velocity": {
			entityId: number;
			velocity: {
				x: number;
				y: number;
				z: number;
			},
		}

		"entity_destroy": {
			entityIds: number[];
		}

		"declare_commands": {
			nodes: {
				flags: {
					command_node_type: number
				};
				children: number[];
				extraNodeData?: {
					name?: string
				};
			}[];
			rootIndex: number;
		}

		/** `content` is a tagged NBT text component — parse with `ChatManager.fromWire`. */
		"system_chat": {
			content: unknown;
			isActionBar: boolean;
		}

		"set_slot": {
			windowId: number;
			slot: number;
			item: unknown | null;
		}

		/** Sent on inventory open / full sync. `items[i]` is the slot at index `i`. `carriedItem` is the cursor stack. */
		"window_items": {
			windowId: number;
			stateId: number;
			items: (unknown | null)[];
			carriedItem: unknown | null;
		}

		/**
		 * Equipment update for an entity. Each entry's `slot` is:
		 * 0=main hand, 1=off hand, 2=boots, 3=leggings, 4=chestplate, 5=helmet.
		 */
		"entity_equipment": {
			entityId: number;
			equipments: {
				slot: number;
				item: unknown | null;
			}[];
		}

		/** Relative entity move — deltas are fixed-point shorts (delta/4096 = blocks). */
		"rel_entity_move": {
			entityId: number;
			dX: number;
			dY: number;
			dZ: number;
			onGround: boolean;
		}

		/** Relative entity move + rotation. yaw/pitch are angle bytes (value*360/256 = degrees). */
		"entity_move_look": {
			entityId: number;
			dX: number;
			dY: number;
			dZ: number;
			yaw: number;
			pitch: number;
			onGround: boolean;
		}

		/** Absolute entity teleport. */
		"entity_teleport": {
			entityId: number;
			x: number;
			y: number;
			z: number;
			yaw: number;
			pitch: number;
			onGround: boolean;
		}

		/**
		 * Clientbound Player Position And Look — server forcibly sets the player's own position.
		 * `flags` marks which axes are relative; on 1.20.6 it parses as an object (`{ x, y, z, yaw,
		 * pitch }` booleans plus the raw `_value` bitmask) — read it with `isRelative`.
		 * yaw/pitch are floats in degrees.
		 */
		"position": {
			x: number;
			y: number;
			z: number;
			yaw: number;
			pitch: number;
			flags: import("~/client/minecraft/protocol").PositionFlags;
			teleportId: number;
		}

	}

}