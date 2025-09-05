/**
 * The maximum amount of pearls to throw at a player
 * For example, if this is set to 2, the bot will only throw 2 pearls at a player
 * Set this to -1 to disable pearl limiting
 * @default 3
 */
export const STASIS_USER_MAX = parseInt(process.env.STASIS_USER_MAX || "3");

/**
 * The maximum distance to search for a stasis chamber when a player requests one
 * For example, if this is set to 100, the bot will only consider chambers within 100 blocks
 * This must be less then the entity broadcast range on the server (default 128)
 * Set this to -1 to disable distance limiting
 * @default 100
*/
export const STASIS_DISTANCE_MAX = parseInt(process.env.STASIS_DISTANCE_MAX || "100");

/**
 * The prefix to use for chat commands
 * For example, if this is set to "!", the bot will respond to commands that start with "!"
 * Set this to an empty string to disable chat commands
 * @default "!"
 */
export const COMMAND_CHAT_PREFIX = process.env.COMMAND_CHAT_PREFIX || "!";

/**
 * The aliases to use for the stasis command in chat
 * For example, if this is set to "tp,teleport", the bot will respond to "!tp" and "!teleport"
 * Separate multiple aliases with a comma
 * @default "base"
 */
export const STASIS_LOCATION_NAME = process.env.STASIS_LOCATION_NAME || "base";