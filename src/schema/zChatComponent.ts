import z from "zod";

/* ========================================================================== */
/*  Minecraft Java Edition Text Component (1.21.5+)                            */
/*  Spec: https://minecraft.wiki/w/Text_component_format                       */
/* ========================================================================== */

/* -------------------------------- Colors ---------------------------------- */

const namedColors = [
	"black",
	"dark_blue",
	"dark_green",
	"dark_aqua",
	"dark_red",
	"dark_purple",
	"gold",
	"gray",
	"dark_gray",
	"blue",
	"green",
	"aqua",
	"red",
	"light_purple",
	"yellow",
	"white"
] as const;

/** Named color OR `#rrggbb` hex string. */
const zColor = z.union([
	z.enum(namedColors),
	z.string().regex(/^#[0-9a-fA-F]{6}$/)
]);

/* ----------------------------- Click events ------------------------------- */

const zClickEvent = z.discriminatedUnion("action", [
	z.object({ action: z.literal("open_url"), url: z.string() }),
	z.object({ action: z.literal("open_file"), path: z.string() }),
	z.object({ action: z.literal("run_command"), command: z.string() }),
	z.object({ action: z.literal("suggest_command"), command: z.string() }),
	z.object({ action: z.literal("change_page"), page: z.number().int().positive() }),
	z.object({ action: z.literal("copy_to_clipboard"), value: z.string() }),
	z.object({
		action: z.literal("show_dialog"),
		dialog: z.union([ z.string(), z.record(z.string(), z.unknown()) ])
	}),
	z.object({
		action: z.literal("custom"),
		id: z.string(),
		payload: z.string().optional()
	})
]);

/* ----------------------------- Hover events ------------------------------- */

/** Lazily references `zChatComponent` so the recursive type works. */
const zHoverEvent = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("show_text"),
		value: z.lazy(() => zChatComponent)
	}),
	z.object({
		action: z.literal("show_item"),
		id: z.string(),
		count: z.number().int().optional(),
		components: z.record(z.string(), z.unknown()).optional()
	}),
	z.object({
		action: z.literal("show_entity"),
		name: z.lazy(() => zChatComponent).optional(),
		id: z.string(),
		uuid: z.union([
			z.string(),
			z.array(z.number().int()).length(4)
		])
	})
]);

/* ----------------------------- Score object ------------------------------- */

const zScore = z.object({
	name: z.string(),
	objective: z.string()
});

/* ----------------------- Shared formatting fields ------------------------- */

/**
 * Shadow color — either a single ARGB int or a `[r, g, b, a]` float array.
 */
const zShadowColor = z.union([
	z.number().int(),
	z.array(z.number()).length(4)
]);

/**
 * Every formatting / interactivity field that can appear on any
 * text component object, regardless of content type.
 */
const sharedFields = {
	color: zColor.optional(),
	font: z.string().optional(),
	bold: z.boolean().optional(),
	italic: z.boolean().optional(),
	underlined: z.boolean().optional(),
	strikethrough: z.boolean().optional(),
	obfuscated: z.boolean().optional(),
	shadow_color: zShadowColor.optional(),
	insertion: z.string().optional(),
	click_event: zClickEvent.optional(),
	hover_event: zHoverEvent.optional(),
	extra: z.lazy(() => z.array(zChatComponent)).optional()
};

/* --------------------------- Content variants ----------------------------- */

/** `{ type?: "text", text: string }` */
const zPlainText = z.object({
	type: z.literal("text").optional(),
	text: z.string(),
	...sharedFields
});

/** `{ type?: "translatable", translate: string, fallback?, with? }` */
const zTranslatable = z.object({
	type: z.literal("translatable").optional(),
	translate: z.string(),
	fallback: z.string().optional(),
	with: z.lazy(() => z.array(zChatComponent)).optional(),
	...sharedFields
});

/** `{ type?: "score", score: { name, objective } }` */
const zScoreComponent = z.object({
	type: z.literal("score").optional(),
	score: zScore,
	...sharedFields
});

/** `{ type?: "selector", selector: string, separator? }` */
const zSelector = z.object({
	type: z.literal("selector").optional(),
	selector: z.string(),
	separator: z.lazy(() => zChatComponent).optional(),
	...sharedFields
});

/** `{ type?: "keybind", keybind: string }` */
const zKeybind = z.object({
	type: z.literal("keybind").optional(),
	keybind: z.string(),
	...sharedFields
});

/** NBT source for `nbt` content type. */
const zNbtSource = z.enum([ "block", "entity", "storage" ]);

/** `{ type?: "nbt", nbt: string, source?, interpret?, separator?, block?, entity?, storage? }` */
const zNbt = z.object({
	type: z.literal("nbt").optional(),
	nbt: z.string(),
	source: zNbtSource.optional(),
	interpret: z.boolean().optional(),
	separator: z.lazy(() => zChatComponent).optional(),
	block: z.string().optional(),
	entity: z.string().optional(),
	storage: z.string().optional(),
	...sharedFields
});

/** Atlas sub-type of the `object` content type. */
const zAtlasObject = z.object({
	type: z.literal("object").optional(),
	object: z.literal("atlas").optional(),
	atlas: z.string().optional(),
	sprite: z.string(),
	...sharedFields
});

/** Player sub-type of the `object` content type. */
const zPlayerObject = z.object({
	type: z.literal("object").optional(),
	object: z.literal("player"),
	player: z.union([ z.string(), z.record(z.string(), z.unknown()) ]),
	hat: z.boolean().optional(),
	...sharedFields
});

/* ----------------------------- Component root ----------------------------- */

/**
 * A single text component **object** (not counting string / array shorthand).
 * Covers all seven content types from the spec.
 */
const zChatComponentObject = z.union([
	zPlainText,
	zTranslatable,
	zScoreComponent,
	zSelector,
	zKeybind,
	zNbt,
	zAtlasObject,
	zPlayerObject
]);

/**
 * Full Minecraft text component.
 *
 * A component can be:
 *  - A plain **string** (shorthand for `{ text: "..." }`)
 *  - An **array** of components (first element is parent, rest are `extra`)
 *  - A component **object** with a content type + optional formatting/events
 */
export const zChatComponent: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z.array(zChatComponent),
		zChatComponentObject
	])
);

export type ChatComponent = z.infer<typeof zChatComponent>;
