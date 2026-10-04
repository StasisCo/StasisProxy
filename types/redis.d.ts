declare namespace Redis {

	type MessageOf<K extends ValidChannel> = Subscriptions[K];
	type ValidChannel = keyof Subscriptions & string;
	type ValueOf<K extends string> = K extends keyof Schema ? Schema[K] : never;

	interface Schema {

		"stasisproxy:discord:register": true;
        
		[key: `stasisproxy:discord:interaction:${ string }`]: string | true;
        
		[key: `stasisproxy:discord:ignlink:${ string }:message`]: { type: "interaction-original", applicationId: string, token: string };

		[key: `stasisproxy:discord:ignlink:${ string }:user`]: { id: string };

		[key: `stasisproxy:discord:ignlink:${ string }:lock`]: true;

		[key: `stasisproxy:stasis:pearl:${ number }:owner`]: string;

		[key: `stasisproxy:stasis:claim:${ string }`]: string;

		[key: `stasisproxy:queue:${ string }:eta`]: { factor: number, pow: number };

		[key: `stasisproxy:bot:online:${ string }`]: { host: string };

		[key: `stasisproxy:mcacache:${ string }`]: z.infer<typeof zMojangUser>;

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
			notify?: boolean,
		}
		| {
			type: "stasis-query",
			id: string,
			from: string,
			playerUuid: string,
			locations: string[],
		}
		| {
			type: "stasis-reply",
			id: string,
			from: string,
			stasis: Array<{ id: string, distance: number | null }> | null,
		}

}