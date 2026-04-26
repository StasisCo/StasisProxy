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

	}

}