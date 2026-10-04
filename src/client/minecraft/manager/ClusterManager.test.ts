import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Vec3 } from "vec3";

/**
 * ClusterManager with Redis, the Minecraft connection and the database replaced by in-memory
 * stand-ins. This bot's site is at the origin, named "farms,farm,fmtp", holding up to 2 pearls
 * per player; its peers are scripted — publishing a stasis-query delivers each peer's answer
 * the way the cluster channel would.
 */
const SELF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAYER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHANNEL = "stasisproxy:cluster:test.invalid";

process.env.STASIS_LOCATION_NAME = "farms,farm,fmtp";
process.env.STASIS_USER_MAX = "4";
process.env.STASIS_SITE_MAX = "2";

type View = Array<{ id: string, distance: number | null }>;

/** Peers on the cluster channel: a view, null for a site with another name, or "silent" for a bot that never answers */
let peers: Array<{ id: string, stasis: View | null | "silent" }> = [];

/** The chambers this bot can see for the player */
let mine: Array<{ id: string, isArmed: () => boolean, block: { position: Vec3 } }> = [];

const published: Array<{ channel: string, message: Record<string, unknown> | string }> = [];
const keys = new Map<string, unknown>();
const player = { uuid: PLAYER, username: "Steve" };
const whisper = mock((_player: typeof player, _message: string) => {});

/** Like the real one: the pearls left at this site once one is loaded, or -1 if there is none to load */
const enqueue = mock(async(_player: string) => mine.some(chamber => chamber.isArmed()) ? mine.length - 1 : -1);

const redis = {
	async emit(channel: string, message: Record<string, unknown> | string) {
		published.push({ channel, message });
		if (typeof message === "string" || message.type !== "stasis-query") return 1;
		for (const peer of peers) {
			if (peer.stasis === "silent") continue;
			const stasis = peer.stasis;
			queueMicrotask(() => ClusterManager.collect({ type: "stasis-reply", id: message.id as string, from: peer.id, stasis }));
		}
		return peers.length + 1;
	},
	async set(key: string, value: unknown, ...options: string[]) {
		if (options.includes("NX") && keys.has(key)) return null;
		keys.set(key, value);
		return "OK";
	}
};

mock.module("~/redis", () => ({ redis }));
mock.module("~/client/minecraft/Stasis", () => ({ Stasis: { fetch: async() => mine }}));
mock.module("~/client/minecraft/manager/StasisManager", () => ({ StasisManager: { enqueue }}));
mock.module("~/client/minecraft/MinecraftClient", () => ({
	MinecraftClient: {
		session: { selectedProfile: { id: SELF.replace(/-/g, "") }},
		host: "test.invalid",
		queue: { isQueued: false },
		chat: { whisper },
		bot: { entity: { position: new Vec3(0, 64, 0) }, players: { Steve: player }}
	}
}));

const { ClusterManager } = await import("./ClusterManager");

/** A chamber this bot can see, `distance` blocks away */
const chamber = (id: string, distance: number, armed = true) => ({ id, isArmed: () => armed, block: { position: new Vec3(distance, 64, 0) }});

const sent = (type: string) => published.map(p => p.message).filter(m => typeof m !== "string" && m.type === type);

beforeEach(() => {
	peers = [];
	mine = [];
	published.length = 0;
	keys.clear();
	enqueue.mockClear();
	whisper.mockClear();
});

describe("survey", () => {

	test("counts this site's pearls, and a chamber two bots can see once in the total", async() => {
		mine = [ chamber("S1", 30), chamber("S2", 50) ];
		peers = [ { id: PEER, stasis: [ { id: "S2", distance: 50 }, { id: "S3", distance: 4 } ]} ];

		expect(await ClusterManager.survey(PLAYER)).toEqual({ local: 2, total: 3, nearest: { botId: PEER, distance: 4 }});
	});

	test("counts a pearl nobody can pull, but never picks it", async() => {
		mine = [ chamber("S1", 3, false) ];
		peers = [ { id: PEER, stasis: [ { id: "S2", distance: null } ]} ];

		expect(await ClusterManager.survey(PLAYER)).toEqual({ local: 1, total: 2, nearest: null });
	});

	test("leaves out sites with another name", async() => {
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: null } ];

		expect(await ClusterManager.survey(PLAYER)).toEqual({ local: 1, total: 1, nearest: { botId: SELF, distance: 30 }});
	});

	test("asks about every name of this site unless told which", async() => {
		await ClusterManager.survey(PLAYER);
		await ClusterManager.survey(PLAYER, [ "fmtp" ]);

		expect(sent("stasis-query").map(query => (query as { locations: string[] }).locations)).toEqual([ [ "farms", "farm", "fmtp" ], [ "fmtp" ] ]);
	});

	test("decides without a peer that never answers", async() => {
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: "silent" } ];

		const started = performance.now();
		expect(await ClusterManager.survey(PLAYER)).toEqual({ local: 1, total: 1, nearest: { botId: SELF, distance: 30 }});
		expect(performance.now() - started).toBeGreaterThan(1_000);
	});

});

describe("pull", () => {

	test("loads at this site and reports what is left here", async() => {
		mine = [ chamber("S1", 30), chamber("S2", 50) ];

		expect(await ClusterManager.pull(PLAYER)).toBe("Loading your pearl, you have 1 / 2 pearls remaining.");
		expect(enqueue).toHaveBeenCalledWith(PLAYER);
	});

	test("loads at this site even when another is nearer, and mentions the pearls held there", async() => {
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: [ { id: "S3", distance: 4 }, { id: "S4", distance: 9 } ]} ];

		expect(await ClusterManager.pull(PLAYER)).toBe("Loading your pearl, you have 0 / 2 pearls remaining (2 total).");
		expect(enqueue).toHaveBeenCalledWith(PLAYER);
		expect(sent("request-load")).toEqual([]);
	});

	test("has nothing to load when the player's pearls are all at other sites", async() => {
		peers = [ { id: PEER, stasis: [ { id: "S3", distance: 4 } ]} ];

		expect(await ClusterManager.pull(PLAYER)).toBeNull();
		expect(sent("request-load")).toEqual([]);
	});

});

describe("load", () => {

	test("routes the request to the site nearest to a pearl, which answers the player itself", async() => {
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: [ { id: "S3", distance: 4 } ]} ];

		expect(await ClusterManager.load(PLAYER, "farms")).toBe(true);
		expect(sent("request-load")).toEqual([ { type: "request-load", playerUuid: PLAYER, destinationUuid: PEER, notify: true } ]);
		expect(enqueue).not.toHaveBeenCalled();
		expect(whisper).not.toHaveBeenCalled();
	});

	test("loads here and whispers the player when this site is the nearest", async() => {
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: [ { id: "S3", distance: 80 } ]} ];

		expect(await ClusterManager.load(PLAYER, "farms")).toBe(true);
		expect(enqueue).toHaveBeenCalledWith(PLAYER);
		expect(whisper).toHaveBeenCalledWith(player, "Loading your pearl, you have 0 / 2 pearls remaining (1 total).");
		expect(sent("request-load")).toEqual([]);
	});

	test("only asks sites with the name the player gave", async() => {
		await ClusterManager.load(PLAYER, "farm");
		expect(sent("stasis-query")[0]).toMatchObject({ locations: [ "farm" ]});
	});

	test("reports when no site has a pearl to load", async() => {
		expect(await ClusterManager.load(PLAYER, "farms")).toBe(false);
		expect(enqueue).not.toHaveBeenCalled();
		expect(whisper).not.toHaveBeenCalled();
	});

});

describe("answer", () => {

	const query = (locations: string[], from = PEER) => ({ type: "stasis-query" as const, id: "q1", from, playerUuid: PLAYER, locations });

	test("tells a site with the same name what it can see", async() => {
		mine = [ chamber("S1", 30), chamber("S2", 7, false) ];
		await ClusterManager.answer(query([ "testing", "farm" ]), SELF, CHANNEL);

		expect(published).toEqual([ { channel: CHANNEL, message: { type: "stasis-reply", id: "q1", from: SELF, stasis: [ { id: "S1", distance: 30 }, { id: "S2", distance: null } ]}} ]);
	});

	test("answers a site with another name with nothing, so it is not kept waiting", async() => {
		mine = [ chamber("S1", 30) ];
		await ClusterManager.answer(query([ "space" ]), SELF, CHANNEL);

		expect(published).toEqual([ { channel: CHANNEL, message: { type: "stasis-reply", id: "q1", from: SELF, stasis: null }} ]);
	});

	test("does not answer its own question", async() => {
		await ClusterManager.answer(query([ "farms" ], SELF), SELF, CHANNEL);
		expect(published).toEqual([]);
	});

});

test("claim lets one bot handle an event", async() => {
	expect(await ClusterManager.claim("load", "farms", PLAYER)).toBe(true);
	expect(await ClusterManager.claim("load", "farms", PLAYER)).toBe(false);
	expect(await ClusterManager.claim("load", "farm", PLAYER)).toBe(true);
	expect([ ...keys.keys() ]).toContain(`stasisproxy:stasis:claim:test.invalid:load:farms:${ PLAYER }`);
});

test("totalSuffix only speaks up when other sites hold pearls", () => {
	expect(ClusterManager.totalSuffix(2, 2)).toBe("");
	expect(ClusterManager.totalSuffix(0, 0)).toBe("");
	expect(ClusterManager.totalSuffix(1, 3)).toBe(" (3 total)");
});
