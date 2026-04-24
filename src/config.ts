/**
 * The maximum amount of pearls to throw at a player
 * For example, if this is set to 2, the bot will only throw 2 pearls at a player
 * Set this to -1 to disable pearl limiting
 * @default 3
 */
export const STASIS_USER_MAX = parseInt(process.env.STASIS_USER_MAX || "3");

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