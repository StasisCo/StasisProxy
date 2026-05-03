declare namespace Redis {

	interface Schema {

		"stasis-proxy:discord:register": true;
        
		[key: `ign-link:${ string }:message`]: { type: "interaction-original", applicationId: string, token: string };
		[key: `ign-link:${ string }:user`]: { id: string };
		[key: `pearl:${ number }:owner`]: string;
		[key: `queue:${ string }:eta`]: { factor: number, pow: number };
		[key: `stasis-proxy:discord:interaction:${ string }`]: true;

	}

	/** Resolves the value type for a given key. */
	type ValueOf<K extends string> = K extends keyof Schema ? Schema[K] : never;

	interface Subscriptions {

		[key: `${ string }:cluster:${ string }:${ string }:queue`]: {
			type: "load";
			player: string;
			status: `${ string }:status`;
			expire?: number;
		};

		[key: `${ string }:status`]: "arrived" | "failed" | "queued" | "succeeded" | "timed-out";

	}

	/** All valid subscription channel strings. */
	type ValidChannel = `${ string }:cluster:${ string }:${ string }:queue` | `${ string }:status`;

	/** Resolves the message type for a given channel. */
	type MessageOf<K extends string> =
		K extends `${ string }:cluster:${ string }:${ string }:queue` ? Subscriptions[`${ string }:cluster:${ string }:${ string }:queue`] :
			K extends `${ string }:status` ? Subscriptions[`${ string }:status`] :
				never;

}