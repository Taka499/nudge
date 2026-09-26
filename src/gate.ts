/**
 * Which repositories this instance serves: the `ALLOWED_OWNERS` secret, repository owners,
 * comma-separated (plan decisions A15 and A24: the only gate, in every milestone). GitHub owner
 * names are case-insensitive, so the comparison is too. An empty or missing list allows nobody,
 * which is what an instance with no secrets does; the acceptance instance relies on it.
 */

export function parseAllowedOwners(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((owner) => owner.trim().toLowerCase())
    .filter((owner) => owner !== "");
}

export function isAllowedOwner(owner: string, allowed: readonly string[]): boolean {
  return allowed.includes(owner.trim().toLowerCase());
}
