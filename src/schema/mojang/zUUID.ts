import z from "zod";

export const zMojangUUID = z.string().regex(/^[0-9a-fA-F]{32}$/).transform(uuid => uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"));