declare module "prismarine-physics" {
	import type { Vec3 } from "vec3";

	interface Controls {
		forward: boolean;
		back: boolean;
		left: boolean;
		right: boolean;
		jump: boolean;
		sprint: boolean;
		sneak: boolean;
	}

	class PlayerState {
		pos: Vec3;
		vel: Vec3;
		onGround: boolean;
		isInWater: boolean;
		isInLava: boolean;
		isInWeb: boolean;
		isCollidedHorizontally: boolean;
		isCollidedVertically: boolean;
		elytraFlying: boolean;
		jumpTicks: number;
		jumpQueued: boolean;
		fireworkRocketDuration: number;
		yaw: number;
		pitch: number;
		control: Controls;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prismarine-physics accepts a mineflayer-like bot object
		constructor(bot: any, control: Controls);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prismarine-physics accepts a mineflayer-like bot object
		apply(bot: any): void;
	}

	interface PhysicsEngine {
		yawSpeed: number;
		pitchSpeed: number;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- world is a prismarine-world instance
		simulatePlayer(state: PlayerState, world: any): PlayerState;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mcData is a minecraft-data instance
	export function Physics(mcData: any, world: any): PhysicsEngine;
	export { PlayerState };
	export type { Controls, PhysicsEngine };
}
