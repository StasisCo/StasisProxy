import z from "zod";

export const zMojangUsername = z.string().min(3).max(16).regex(/^[a-zA-Z0-9_]+$/);