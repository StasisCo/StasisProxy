/** 
 * The health threshold to trigger auto disconnect if we have low totems
 * For example, if this is set to 8, the bot will disconnect if it has 3 or less totems and 8 or less health
 * Set this to -1 to disable auto disconnecting based on health
 * @default 8
 */
export const AUTODISCONNECT_MIN_HEALTH = parseInt(process.env.AUTODISCONNECT_MIN_HEALTH || "8");

/**
 * The food threshold to trigger auto eating
 * For example, if this is set to 20, the bot will eat food if it has 20 or less hunger points
 * Set this to -1 to disable auto eating
 * @default 20
 */
export const AUTOEAT_MIN_FOOD = parseInt(process.env.AUTOEAT_MIN_FOOD || "20");

/**
 * The amount of totems to make sure we always have on hand
 * For example, if this is set to 3, the bot will disconnect if it has 3 or less totems and is low on health
 * Set this to -1 to disable auto disconnecting based on totem count
 * @default 3
 */
export const AUTOTOTEM_MIN_TOTEM = parseInt(process.env.AUTOTOTEM_MIN_TOTEM || "3");

/**
 * The aliases to use for the stasis command in chat
 * For example, if this is set to "tp,teleport", the bot will respond to "!tp" and "!teleport"
 * Separate multiple aliases with a comma
 * @default "tp,teleport,tele,tel"
 */
export const COMMAND_CHAT_ALIAS = process.env.COMMAND_CHAT_ALIAS || "tp,teleport,tele,tel";

/**
 * Weather or not to enable commands in the public chat
 * If this is set to false, the bot will only respond to private messages (whispers)
 * @default true
 */
export const COMMAND_CHAT_DISABLED = Boolean(process.env.COMMAND_CHAT_DISABLED);

/**
 * The prefix to use for chat commands
 * For example, if this is set to "!", the bot will respond to commands that start with "!"
 * Set this to an empty string to disable chat commands
 * @default "!"
 */
export const COMMAND_CHAT_PREFIX = process.env.COMMAND_CHAT_PREFIX || "!";

/**
 * The maximum distance to search for a stasis chamber when a player requests one
 * For example, if this is set to 100, the bot will only consider chambers within 100 blocks
 * This must be less then the entity broadcast range on the server (default 128)
 * Set this to -1 to disable distance limiting
 * @default 100
*/
export const STASIS_DISTANCE_MAX = parseInt(process.env.STASIS_DISTANCE_MAX || "100");

/**
 * The maximum amount of pearls to throw at a player
 * For example, if this is set to 2, the bot will only throw 2 pearls at a player
 * Set this to -1 to disable pearl limiting
 * @default 2
 */
export const STASIS_USER_MAX = parseInt(process.env.STASIS_USER_MAX || "2");

/**
 * The maximum distance to search for a trapdoor when a player requests one
 * For example, if this is set to 5, the bot will only consider trapdoors within 5 blocks
 * This must be less then the entity broadcast range on the server (default 128)
 * @default 5
 */
export const STASIS_TRAPDOOR_RANGE = parseInt(process.env.STASIS_TRAPDOOR_RANGE || "5");

