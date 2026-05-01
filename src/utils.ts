export function normalizeUUID(uuid: string) {
	return uuid
		.replace(/-/g, "")
		.toLowerCase()
		.replace(/([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})/, "$1-$2-$3-$4-$5");
}