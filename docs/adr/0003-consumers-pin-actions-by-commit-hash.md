---
status: accepted
---

# Consumers pin Nudge's actions by commit hash; exact versions ship as immutable Releases

Every self-hoster's workflows run the composite actions from `Taka499/nudge` inside their own jobs, which hold `id-token: write` (and, from Milestone 2, merge rights; in Milestone 3, a Cloudflare token), so whoever can move a tag of this repository decides what code runs with those permissions in every consumer. The documented form is therefore `uses: Taka499/nudge/actions/<name>@<40-character commit hash> # vX.Y.Z`, kept current by Dependabot. Each exact version `vX.Y.Z` is published as a GitHub Release, which immutable releases (enabled on this repository) lock to its commit. The major tag `v1` stays a plain tag with no Release, moved only to compatible changes — compatible also with Workers deployed from earlier `v1` versions — for consumers who accept following it. The actions contain no nested `uses:`, so a hash pin covers all the code they run, and this repository's own workflows pin every action by hash too; `src/pinning.test.ts` enforces both. Rejected: `@v1` as the documented form (the trust root of every consumer's job would be one movable tag; a self-hoster's deployed Worker and a later action could drift apart; organisations that require hash pinning could not use it at all).

Source: user decision, session 2026-09-24, after an automated security check in `tia-tools/gakumas-supportcards` flagged `@v1`; recorded as plan decision A19 (`docs/plans/EXECPLAN_NUDGE.md` § Decision Log), amending A14's reference form. Immutable releases confirmed enabled through GitHub's API the same day.
