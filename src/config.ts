/**
 * The maximum amount of pearls a player can have across every site that shares this bot's location name
 * For example, if this is set to 4, a player holding 4 pearls between the sites named "farms" can't set another at any of them
 * Set this to -1 to disable pearl limiting
 * @default 3
 */
export const STASIS_USER_MAX = parseInt(process.env.STASIS_USER_MAX || "3");

/**
 * The maximum amount of pearls a player can have at this bot's site
 * For example, if this is set to 2, the bot will only hold 2 pearls for a player
 * Set this to -1 to disable the per-site limit
 * @default STASIS_USER_MAX
 */
export const STASIS_SITE_MAX = process.env.STASIS_SITE_MAX ? parseInt(process.env.STASIS_SITE_MAX) : STASIS_USER_MAX;

/**
 * The names of the location this bot's site belongs to, which players pass to chat commands
 * For example, if this is set to "tp,teleport", the bot will respond to "!load tp" and "!load teleport"
 * Separate multiple names with a comma
 * Several bots on the same server can share a name, each looking after its own site — see ClusterManager
 * @default "base"
 */
export const STASIS_LOCATION_NAMES = (process.env.STASIS_LOCATION_NAME || "base")
	.split(",")
	.map(name => name.trim().toLowerCase())
	.filter(name => name.length > 0);
