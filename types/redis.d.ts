declare namespace Redis {

	type MessageOf<K extends ValidChannel> = Subscriptions[K];
	type ValidChannel = keyof Subscriptions & string;
	type ValueOf<K extends string> = K extends keyof Schema ? Schema[K] : never;

	interface Schema {

		"stasis-proxy:discord:register": true;
        
		[key: `stasisproxy:discord:interaction:${ string }`]: true;
        
		[key: `stasisproxy:discord:ignlink:${ string }:message`]: { type: "interaction-original", applicationId: string, token: string };

		[key: `stasisproxy:discord:ignlink:${ string }:user`]: { id: string };

		[key: `stasisproxy:stasis:pearl:${ number }:owner`]: string;

		[key: `stasisproxy:queue:${ string }:eta`]: { factor: number, pow: number };

	}

	interface Subscriptions {

		[key: `stasisproxy:cluster:${ string }`]: ClusterMessage;

		[key: `stasisproxy:stasis:status:${ string }`]: "arrived" | "failed" | "queued" | "succeeded" | "timed-out";

	}

	type ClusterMessage =
		| {
			type: "bot-connect",
			bot: {
				id: string,
				name: string,
				version: string
			}
		}
		| {
			type: "request-load",
			playerUuid: string,
			destinationUuid: string,
			statusKey?: `stasisproxy:stasis:status:${ string }`,
		}

}