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

		"set_title_text": {
			text: string;
		},

		"set_title_subtitle": {
			text: string;
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

		"respawn": {
			dimension: string | { name: string };
			worldName: string;
			hashedSeed: bigint;
			gamemode: number;
			previousGamemode: number;
			isDebug: boolean;
			isFlat: boolean;
			copyMetadata: boolean;
			death?: {
				dimensionName: string;
				location: { x: number; y: number; z: number };
			};
			portalCooldown: number;
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

		"system_chat": {
			content: string | unknown;
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
		 * `flags` is a bitmask: 0x01=X relative, 0x02=Y relative, 0x04=Z relative, 0x08=Y_ROT relative, 0x10=X_ROT relative.
		 * yaw/pitch are floats in degrees.
		 */
		"position": {
			x: number;
			y: number;
			z: number;
			yaw: number;
			pitch: number;
			flags: number;
			teleportId: number;
		}

	}

}