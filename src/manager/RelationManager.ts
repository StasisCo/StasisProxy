import { YAML } from "bun";
import { readFile, watch } from "fs/promises";
import { type Bot } from "mineflayer";
import z from "zod";

const zRelation = z.object({
	usernames: z.string().array(),
	uuid: z.uuid(),
	type: z.enum([ "friend", "enemy" ])
});

export class RelationManager {

	private cache: string | null = null;

	constructor(_bot: Bot) {

		const file = process.env.RELATIONS_FILE;
		if (!file) return;

		this.load(file);
		this.watch(file);

	}

	private load(file: string) {
		readFile(file, "utf-8")
			.then(content => this.cache = content)
			.catch(() => {});
	}

	private async watch(file: string) {
		try {
			for await (const event of watch(file, { persistent: false })) {
				if (event.eventType === "change") this.load(file);
			}
		} catch {
		}
	}

	get list() {
		const rels: z.infer<typeof zRelation>[] = [];
		const { relations } = YAML.parse(this.cache ?? "") as { relations?: unknown[] };
		if (!relations || !Array.isArray(relations)) return [];
		for (const rel of relations) {
			const { success, data } = zRelation.safeParse(rel);
			if (success) rels.push(data);
		}
		return Array.from(rels);
	}

}