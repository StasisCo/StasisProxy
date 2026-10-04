import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Vec3 } from "vec3";

/**
 * ClusterManager with Redis, the Minecraft connection and the database replaced by in-memory
 * stand-ins. This bot is at the origin serving "farms,farm,fmtp" with a limit of 2; its peers
 * are scripted — publishing a stasis-query delivers each peer's answer the way the cluster
 * channel would.
 */
const SELF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PEER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAYER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHANNEL = "stasisproxy:cluster:test.invalid";
const POOL = "stasisproxy:stasis:pool:test.invalid";
const STATUS = "stasisproxy:stasis:status:test";

process.env.STASIS_LOCATION_NAME = "farms,farm,fmtp";
process.env.STASIS_USER_MAX = "2";

type View = Array<{ id: string, distance: number | null }>;

/** Peers on the cluster channel: a view, null for a bot at another location, or "silent" for one that never answers */
let peers: Array<{ id: string, stasis: View | null | "silent" }> = [];

/** The chambers this bot can see for the player */
let mine: Array<{ id: string, isArmed: () => boolean, block: { position: Vec3 } }> = [];

const published: Array<{ channel: string, message: Record<string, unknown> | string }> = [];
const hashes = new Map<string, Record<string, unknown>>();
const keys = new Map<string, unknown>();
const enqueue = mock(async(_player: string, _statusKey?: string) => 0);

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
	},
	async hset(key: string, field: string, value: unknown) {
		hashes.set(key, { ...hashes.get(key), [field]: value });
	},
	async hgetall(key: string) {
		return hashes.get(key) ?? {};
	},
	async hdel(key: string, field: string) {
		delete hashes.get(key)?.[field];
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
		bot: { entity: { position: new Vec3(0, 64, 0) }}
	}
}));

const { ClusterManager } = await import("./ClusterManager");

/** A chamber this bot can see, `distance` blocks away */
const chamber = (id: string, distance: number, armed = true) => ({ id, isArmed: () => armed, block: { position: new Vec3(distance, 64, 0) }});

/** A peer's record in the pool */
const member = (max: number, locations = [ "farms" ], seen = Date.now()) => ({ locations, max, seen });

const requests = () => published.map(p => p.message).filter(m => typeof m !== "string" && m.type === "request-load");

beforeEach(() => {
	peers = [];
	mine = [];
	published.length = 0;
	hashes.clear();
	keys.clear();
	enqueue.mockClear();
	enqueue.mockImplementation(async() => 0);
});

describe("survey", () => {

	test("counts a chamber two bots can see once, against the sum of their limits", async() => {
		hashes.set(POOL, { [PEER]: member(3) });
		mine = [ chamber("S1", 30), chamber("S2", 50) ];
		peers = [ { id: PEER, stasis: [ { id: "S2", distance: 50 }, { id: "S3", distance: 4 } ]} ];

		expect(await ClusterManager.survey(PLAYER)).toEqual({ total: 3, limit: 5, nearest: { botId: PEER, distance: 4 }});
	});

	test("counts a pearl nobody can pull, but never picks it", async() => {
		mine = [ chamber("S1", 3, false) ];
		peers = [ { id: PEER, stasis: [ { id: "S2", distance: null } ]} ];

		expect(await ClusterManager.survey(PLAYER)).toEqual({ total: 2, limit: 2, nearest: null });
	});

	test("leaves out bots at other locations", async() => {
		hashes.set(POOL, { [PEER]: member(5, [ "space" ]) });
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: null } ];

		expect(await ClusterManager.survey(PLAYER)).toEqual({ total: 1, limit: 2, nearest: { botId: SELF, distance: 30 }});
	});

	test("keeps the limit of a member that is down, until it has been gone for a day", async() => {
		hashes.set(POOL, { [PEER]: member(3, [ "farm" ], Date.now() - 60 * 60 * 1000) });
		expect((await ClusterManager.survey(PLAYER)).limit).toBe(5);

		hashes.set(POOL, { [PEER]: member(3, [ "farm" ], Date.now() - 25 * 60 * 60 * 1000) });
		expect((await ClusterManager.survey(PLAYER)).limit).toBe(2);
		expect(hashes.get(POOL)).toEqual({});
	});

	test("is unlimited when any member is", async() => {
		hashes.set(POOL, { [PEER]: member(-1) });
		expect((await ClusterManager.survey(PLAYER)).limit).toBe(-1);
	});

	test("decides without a peer that never answers", async() => {
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: "silent" } ];

		const started = performance.now();
		expect(await ClusterManager.survey(PLAYER)).toEqual({ total: 1, limit: 2, nearest: { botId: SELF, distance: 30 }});
		expect(performance.now() - started).toBeGreaterThan(1_000);
	});

});

describe("load", () => {

	test("hands the pull to the peer that is nearest to a pearl", async() => {
		hashes.set(POOL, { [PEER]: member(3) });
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: [ { id: "S3", distance: 4 } ]} ];

		expect(await ClusterManager.load(PLAYER, STATUS)).toEqual({ remaining: 1, limit: 5 });
		expect(requests()).toEqual([ { type: "request-load", playerUuid: PLAYER, destinationUuid: PEER, statusKey: STATUS, direct: true } ]);
		expect(enqueue).not.toHaveBeenCalled();
	});

	test("pulls itself when it is the nearest", async() => {
		mine = [ chamber("S1", 30) ];
		peers = [ { id: PEER, stasis: [ { id: "S3", distance: 80 } ]} ];

		expect(await ClusterManager.load(PLAYER, STATUS)).toEqual({ remaining: 1, limit: 2 });
		expect(enqueue).toHaveBeenCalledWith(PLAYER, STATUS);
		expect(requests()).toEqual([]);
	});

	test("fails the request when there is no pearl to pull", async() => {
		expect(await ClusterManager.load(PLAYER, STATUS)).toBeNull();
		expect(enqueue).not.toHaveBeenCalled();
		expect(published.at(-1)).toEqual({ channel: STATUS, message: "failed" });
	});

});

describe("answer", () => {

	const query = (locations: string[], from = PEER) => ({ type: "stasis-query" as const, id: "q1", from, playerUuid: PLAYER, locations });

	test("tells a peer at the same location what it can see", async() => {
		mine = [ chamber("S1", 30), chamber("S2", 7, false) ];
		await ClusterManager.answer(query([ "testing", "farm" ]), SELF, CHANNEL);

		expect(published).toEqual([ { channel: CHANNEL, message: { type: "stasis-reply", id: "q1", from: SELF, stasis: [ { id: "S1", distance: 30 }, { id: "S2", distance: null } ]}} ]);
	});

	test("answers a peer at another location with nothing, so it is not kept waiting", async() => {
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

test("checkIn records this bot's locations and limit", async() => {
	await ClusterManager.checkIn();
	expect(hashes.get(POOL)).toEqual({ [SELF]: { locations: [ "farms", "farm", "fmtp" ], max: 2, seen: expect.any(Number) }});
});
