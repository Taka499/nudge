/**
 * Which repositories this instance serves (plan decision A15, Milestone 1 form).
 *
 * The allowlist is the `ALLOWED_OWNERS` variable: repository owners, comma-separated. GitHub
 * owner names are case-insensitive, so the comparison is too. An empty list allows nobody.
 * Milestone 2 replaces this with the GitHub App installation check.
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
