/**
 * The maximum amount of pearls this bot will hold for a player
 * For example, if this is set to 2, the bot will only hold 2 pearls for a player
 * Bots that share a location name pool their limits, so two bots at the same location with a
 * limit of 2 each let a player keep 4 pearls there
 * Set this to -1 to disable pearl limiting
 * @default 3
 */
export const STASIS_USER_MAX = parseInt(process.env.STASIS_USER_MAX || "3");

/**
 * The names of the location this bot serves, which players pass to chat commands
 * For example, if this is set to "tp,teleport", the bot will respond to "!load tp" and "!load teleport"
 * Separate multiple names with a comma
 * Bots on the same server that share any of these names serve that location together — see ClusterManager
 * @default "base"
 */
export const STASIS_LOCATION_NAMES = (process.env.STASIS_LOCATION_NAME || "base")
	.split(",")
	.map(name => name.trim().toLowerCase())
	.filter(name => name.length > 0);
