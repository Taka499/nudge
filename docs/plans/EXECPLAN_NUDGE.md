# Nudge: notifications and one-tap approvals from GitHub Actions to Discord

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `docs/PLANS.md` at the repository root.

Design confirmed by the user on 2026-09-22 in a grill-me session held in the `gakumas-supportcards` repository; implementation has not started.


## Purpose / Big Picture


Automated workflows in the user's repositories increasingly do things without a person watching: `gakumas-supportcards` regenerates its card data every week and publishes it by itself, and `ss-assist` detects new game characters and opens a pull request with their data and icon. When such a run needs a human — a card it cannot score, a character whose icon must be looked at, a deploy token about to expire — the only channel today is GitHub email, which the user reads least. Nudge is a small Cloudflare Worker at `https://nudge.tia.run` that any of the user's GitHub Actions workflows can call to post a message into one private Discord channel, and, when the message asks a question, to carry Approve and Decline buttons. A tap on Approve does not merge anything: Nudge sends a `repository_dispatch` event back to the repository, and the repository's own committed workflow performs the action (`docs/adr/0001`). The repository then reports the outcome and Nudge edits the message to say merged, failed or declined.

After this plan, the user sees every unattended run's outcome as a Discord push, approves a held card or a new character from the lock screen with one tap, and gets a reminder a month before a Cloudflare token expires, without any repository storing a secret for Nudge (`docs/adr/0002`). Nudge is also a self-hostable template (A12): the repository ships the Worker, the GitHub Actions that consumers call, and a setup guide, and `nudge.tia.run` is only the author's own instance; nothing in the code names it.


## Progress


- [x] (2026-09-22) Design interview (grill-me, in `gakumas-supportcards`): decisions A1–A11 below; repository scaffolded from `Taka499/project-template@b52b8df`; ADRs 0001 and 0002 written.
- [x] (2026-09-24) User-side setup (see Concrete Steps § Before Milestone 1): Discord channel and webhook (Worker secret `DISCORD_WEBHOOK_URL`); the account-owned Cloudflare token "nudge — deploy from GitHub Actions (Taka499/nudge)" and the account id as repository secrets.
- [x] (2026-09-23) Milestone 1 code complete on branch `feature/m1-notify`, awaiting the user-side setup and the first deploy: `src/` (oidc, jwks, gate, validate, discord, worker) with 48 tests across 6 files, `actions/notify`, `.github/workflows/{ci,deploy}.yml`, `README.md`, `docs/SETUP.md`, `wrangler.toml`; `bun test`, `bun run type-check`, `bun run lint` and `bun run deploy:check` pass; eight mutations each turned the suite red. Commits `6cec804`…`ceb790c` plus the lint gate on TypeScript 7 and Oxlint (A17).
- [x] (2026-09-24) Published as the public repository `Taka499/nudge`; Worker deployed by hand, then by `deploy.yml` from the merge of pull request #1 (`2f92e97`); an unauthenticated `POST /notify` answers 401.
- [x] (2026-09-24) Acceptance, first check: a manual run of `update-data.yml` in `tia-tools/gakumas-supportcards`, calling `actions/notify` pinned to `2f92e97`, posted a message naming the repository and linking the run (reported by the user).
- [x] (2026-09-24) Acceptance, refusals and self-hosting: `.github/workflows/acceptance.yml` (pull request #2, merged as `b706447`). Run 35931757508 against `nudge.tia.run`: no token, another audience, tampered signature, unknown key id and an expired token (GitHub's tokens live 300 s; the run waited 360 s) all refused with 401 and the exact expected error. Run 35932326383 added a throwaway instance at `https://nudge-acceptance.tia-tools-dev.workers.dev` deployed from the same commit: a token for `nudge.tia.run` refused with 401 `wrong audience`, a token for its own origin reached its owner gate and got 403. The user confirmed the Discord channel received none of the checks' messages; the throwaway instance was then deleted (404).
- [x] (2026-09-24) `v1` tagged on `b706447` and pushed; `actions/notify` resolves at `@v1`.
- [x] (2026-09-24) Milestone 1: `notify`. OIDC verification with the audience derived from the instance's own origin (A13), the allowed-owners gate (A15), Discord webhook post, deploy workflow; the `notify` composite action and the consumer README (A14, A16); the `v1` tag; `gakumas-supportcards` posts its weekly update outcomes and held-cards notices through the action. Held cards arrive as a count inside the outcome message rather than as a separate notice with the issue link; a separate notice needs the held-cards step in `gakumas-supportcards` to export the issue number, a change in that repository. That repository still pins the action to `2f92e97`; switching it to `@v1` is its next one-line change.
- [ ] User-side setup for Milestone 2: Discord application (public key, bot, interactions endpoint URL); GitHub App "Nudge" (private key, app id, installed on `tia-tools/gakumas-supportcards` and `Taka499/ss-assist`); a KV namespace; the Discord user-id allowlist.
- [ ] Milestone 2: `request` and `resolve`. Buttons, the interactions endpoint with Ed25519 verification, request state in KV, the allowlist and tap rules, the GitHub App and `repository_dispatch`; the installation check replaces the owner gate (A15); the `request`, `resolve` and `guard` composite actions (A14); `gakumas-supportcards` and `ss-assist` consume it.
- [ ] Milestone 3: the reusable Cloudflare token-expiry workflow with an `endpoint` input (A14), called weekly by consuming repositories.
- [ ] Milestone 4 (deferred, not scheduled): a hosted multi-tenant instance keyed per GitHub App installation. Listed so the door is visibly open; see A12 for why it is not planned.


## Surprises & Discoveries


- Observation: Discord lets a plain webhook message carry buttons (Execute Webhook accepts `components`), but a button press is delivered only to an application's Interactions Endpoint URL, signed with Ed25519 (`X-Signature-Ed25519`, `X-Signature-Timestamp`), and Discord removes an endpoint that fails to validate signatures. So Milestone 1 needs only a webhook URL, while Milestone 2 needs a Discord application with a public key and an HTTPS endpoint that answers a type-1 PING with a PONG.
  Evidence: Discord developer documentation, "Receiving and Responding" and "Hosting on Cloudflare Workers", read 2026-09-22.

- Observation: A GitHub App mints an installation token by signing a JWT with its private key and calling `POST /app/installations/{id}/access_tokens`; the token lives one hour and can be restricted at mint time to specific repositories and permissions. This is what makes A2 cheap: no long-lived token exists anywhere.
  Evidence: GitHub documentation, "Generating an installation access token for a GitHub App", read 2026-09-22.

- Observation: ss-assist today has two human checkpoints — reviewing the bot's pull request into `develop` (faction, icon, localised names) and merging the automatic promotion pull request into `main`, which deploys — while `gakumas-supportcards` merges its own routine update and leaves a pull request open only when the merge is refused. Nudge must serve both shapes, which is why the action on Approve belongs to the repository (A1) and not to Nudge.
  Evidence: `ss-assist/.github/workflows/{auto-character,promote-to-main}.yml` and `gakumas-supportcards/.github/workflows/update-data.yml`, read 2026-09-22.

- Observation: With `@types/bun` 1.4 and TypeScript 7, `typeof fetch` includes a `preconnect` member, so a test fake cannot satisfy it; and `Uint8Array.from(...)` is typed `Uint8Array<ArrayBufferLike>`, which `crypto.subtle.verify` refuses as a `BufferSource`. The code defines its own one-method `Fetcher` type (`src/fetcher.ts`) and builds byte arrays over an explicit `ArrayBuffer`.
  Evidence: `bunx tsc --noEmit` on 2026-09-23 while writing Milestone 1; both errors disappeared with those two changes.

- Observation: The `typescript@7` npm package is the native (Go) compiler: `require("typescript")` exposes only the version, no `TypeFlags`, no program API, and typescript-eslint declares `typescript >=4.8.4 <6.1.0`. A project that lints with typescript-eslint must therefore pin TypeScript 5.x; this one pins `^5.9` and type-checks with it too. Also: sonarjs 4.2.1's `null-dereference` reports parameters typed plain `string`, and eslint-plugin-security's `detect-object-injection` and `detect-possible-timing-attacks` fire on `bytes[i]` and on `token !== undefined`; all three are off in `eslint.config.js` with their removal conditions.
  Evidence: `bun run lint` on 2026-09-23 — `TypeError: Cannot read properties of undefined (reading 'Intrinsic')` from `ts-api-utils` under TypeScript 7.0.2; 25 findings on the first run under 5.9.3, of which 11 were those false positives and 14 were fixed in code. Superseded the same day by decision A17: the repo moved to TypeScript 7 with Oxlint; the 14 code fixes stayed.

- Observation: Oxlint 1.85 with oxlint-tsgolint 7.0.2002 runs every type-aware rule the ESLint gate used (`no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-base-to-string`) under TypeScript 7, plus the size limits and `eslint-plugin-security` loaded as a JS plugin. `eslint-plugin-sonarjs` cannot load as a JS plugin either (same `ts-api-utils` crash), Oxlint has no built-in cognitive-complexity rule, and its `jest/expect-expect` does not recognise `bun:test`. Oxlint's JSON config refuses unknown keys, so comments need `oxlint.config.ts`. On this repo Oxlint took 0.18 s against ESLint's 1.9 s, and it found one issue ESLint missed: `readJsonBody` returned `Promise<unknown | Response>`, a union in which `unknown` swallows `Response`; it now returns `{ json: unknown } | Response`.
  Evidence: a trial in a scratch copy on 2026-09-23 with seven injected violations, each reported; then the same in this repository.

- Observation: bun 1.3.5 can hang forever at "Resolving dependencies" after an earlier install was interrupted: it gets `304 Not Modified` for the package manifest and makes no further request. An empty `BUN_INSTALL_CACHE_DIR` fixes it. macOS has no `timeout` command, so a `timeout N bun …` guard silently runs nothing; `perl -e 'alarm N; exec @ARGV' …` works.
  Evidence: `bun add --verbose` log on 2026-09-23, three hangs, each cured by a fresh cache directory.

- Observation: A wrangler environment inherits the top-level `routes`, custom domains included. The first `bun run deploy:acceptance` stopped at "Update them to point to this script instead? (Y/n)" — Y would have moved `nudge.tia.run` onto the throwaway instance, which has no webhook and refuses `Taka499`. The user stopped at the prompt; production kept answering 401 throughout. `wrangler deploy --dry-run` had printed the warning, but the agent's output filter hid it. `[env.acceptance]` now sets `routes = []`, and `src/wrangler-config.test.ts` requires every environment to declare its own routes and keeps the acceptance instance's owner gate from ever allowing `Taka499`.
  Evidence: the user's terminal on 2026-09-24; `wrangler deploy --env acceptance --dry-run` warns "inherits the top-level `routes` configuration" before the fix and not after; the test fails with the line removed.


## Decision Log


- Decision (A1): On Approve, Nudge sends a `repository_dispatch` to the repository naming the request id and the pinned commit; the repository's own committed workflow performs the action. Nudge never merges. Recorded as `docs/adr/0001`.
  Rationale: The service then needs only the permission to send an event, and a compromised service can only invoke workflows the repository already committed. Rejected: merging directly (a merge credential over every installed repository, plus consumer-specific logic in the service); a link-only button.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A2): Nudge authenticates to GitHub as a GitHub App installed per repository, minting a one-hour installation token per tap scoped to that one repository. Rejected: a fine-grained personal access token (long-lived, bound to one person's account, manually rotated — the very thing Nudge exists to remind about).
  Rationale: Nothing long-lived that works everywhere; the App's permission list is visible and auditable on GitHub.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A3): Inbound requests carry a GitHub Actions OIDC token (audience `nudge.tia.run`); Nudge verifies it against GitHub's JWKS and reads repository, run id and commit from its claims. No shared secret per repository. Recorded as `docs/adr/0002`.
  Rationale: Nothing to store or rotate in any consumer, and a request can only come from a real workflow run of that repository.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A4): Three calls. `notify` posts a plain message. `request` posts a message with Approve and Decline buttons and returns a request id. `resolve` lets the repository's workflow report the outcome, and Nudge edits the message to show merged, failed or declined. Every message starts with the repository's name.
  Rationale: Without `resolve`, a tapped message would only ever say "dispatched" and the real outcome would live on GitHub; buttons on every message would be noise.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A5): A tap counts only if the Discord user id is on Nudge's allowlist, the request is unanswered, younger than 7 days, and the dispatch carries the commit the request named; the repository's workflow re-checks that commit against the pull request's current head before acting. A stale or duplicate tap edits the message to say so. Request state is single-use and lives in KV.
  Rationale: A lingering message must not stay live forever, and a tap must never merge newer, unreviewed commits than the ones it was shown.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A6): The Cloudflare token-expiry check is a reusable workflow published by this repository. A consuming repository calls it weekly with its own token secret; the workflow reads the expiry from Cloudflare's token-verify endpoint and sends a `notify` within 30 days of it. Tokens never leave the repository that owns them. Rejected: Nudge holding copies of tokens (a vault of deploy credentials); a hand-written check per repository (copies that drift).
  Rationale: The service that says a token is expiring must not depend on that token, and the check should exist once.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A7): For ss-assist, one tap on Approve merges the data pull request into `develop` and promotes to `main`, releasing to production. The request message carries the new character's name and icon so the visual check happens in Discord, which becomes ss-assist's release checkpoint in place of the promotion pull request on GitHub. This is ss-assist's decision to record in its own documentation when it adopts Nudge; for Nudge it means a request may carry an image, and that a consumer's dispatch handler may perform more than one step.
  Rationale: The user chose the faster path over the agent's recommendation to keep the GitHub release checkpoint, accepting that a wrong icon approved from Discord reaches the public site.
  Date/Author: 2026-09-22 / user, against the agent's recommendation.

- Decision (A8): The repository lives under the `Taka499` account, next to ss-assist; the Worker runs on the tia-tools Cloudflare account at `nudge.tia.run`. The GitHub App "Nudge" is created under `Taka499` and installed on repositories in both `Taka499` and `tia-tools`.
  Rationale: The user's choice; the agent had recommended keeping code and account in the same organisation.
  Date/Author: 2026-09-22 / user.

- Decision (A9): One private Discord server channel; every message names its repository; the allowlist, not channel membership, decides who may approve. Rejected: a channel per repository; direct messages from the bot.
  Rationale: Buttons and mobile push work in a server channel, history is searchable, and a second person could join later without changing anything.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A10): The name is `nudge`: repository `Taka499/nudge`, hostname `nudge.tia.run`, GitHub App "Nudge".
  Rationale: Short and says what it does — it nudges the user and takes a one-tap answer.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A11): Three milestones in this order: `notify` first, then `request` and `resolve` with the buttons and the App, then the expiry workflow. Each is useful on its own; `notify` alone already moves every unattended run's outcome off GitHub email.
  Rationale: The visible feature carries the risk (a credential and an interactions endpoint); the plain half carries most of the daily value and none of the risk.
  Date/Author: 2026-09-22 / user, choosing the agent's recommendation.

- Decision (A12): Nudge is distributed as a self-hosted template: each user deploys their own Worker (on a `workers.dev` hostname or their own domain) from this repository and creates their own Discord application and GitHub App following the setup guide; `nudge.tia.run` is the author's instance and serves only the author's repositories. Rejected for now: a hosted multi-tenant service at one hostname (the author's Worker would become the trust boundary for other people's merges, weakening the argument of `docs/adr/0001`; it needs a per-tenant configuration surface, an uptime and abuse obligation from day one, Discord bot verification once the bot is in 100 servers, and a domain other than `tia.run`, which the user reserves for personal projects); an action that posts straight to a Discord webhook with no Worker (a secret per repository, which A3 rejected, and no buttons). The hosted model stays possible as a later configuration layer keyed per GitHub App installation (Milestone 4, deferred) provided A13 is kept.
  Rationale: Everything the self-hosted model needs is already in Milestones 1–3, so the cost is discipline rather than new work, and each instance only ever touches its own owner's repositories.
  Date/Author: 2026-09-23 / user, choosing the agent's recommendation.

- Decision (A13): No tenant constant in code. The OIDC audience a consumer must request is the instance's own origin (`https://<worker hostname>`), which the Worker derives from the incoming request or from an explicit `NUDGE_AUDIENCE` variable; the Discord channel, webhook, allowed Discord user ids, GitHub App id and key, KV binding and allowed owners are `wrangler` variables and secrets. `docs/adr/0002` is amended accordingly: the audience is "the instance's own hostname", of which `nudge.tia.run` is one value.
  Rationale: Costs nothing now and a migration later; it is the property that makes A12 true and Milestone 4 possible.
  Date/Author: 2026-09-23 / user, choosing the agent's recommendation.

- Decision (A14): The consumer interface is a set of composite actions in this repository — `actions/notify`, `actions/request`, `actions/resolve`, and `actions/guard` (which a consumer's `repository_dispatch` handler runs first to check the pull request's head against the dispatched commit and stop if they differ) — each taking an `endpoint` input, plus the reusable token-expiry workflow of A6 with the same input. Consumers reference them by tag (`Taka499/nudge/actions/notify@v1`); the tag moves only for compatible changes and a breaking change gets `v2`. Rejected: a hand-written step per consumer that fetches the OIDC token and posts JSON (the copy-that-drifts problem A6 rejected for the token check, applied to the main product).
  Rationale: Installing Nudge in a repository becomes a few `uses:` lines; the OIDC token request and the HTTP contract exist once.
  Date/Author: 2026-09-23 / user, choosing the agent's recommendation.

- Decision (A15): A repository is registered with an instance by installing that instance's GitHub App on it; from Milestone 2 the Worker accepts a request only if the App has an installation covering the repository named in the OIDC claims, otherwise 403. Milestone 1 has no App yet and gates on an `ALLOWED_OWNERS` variable (repository owners, e.g. `Taka499,tia-tools`) instead. Rejected: no repository gate (OIDC proves the caller is a real GitHub Actions run, but any repository on GitHub can request a token for this audience and post into the channel).
  Rationale: The install step and the security gate are the same action, so there is nothing extra to configure per consumer, and the open-channel gap is closed from the first milestone.
  Date/Author: 2026-09-23 / user, choosing the agent's recommendation.

- Decision (A16): The consumer-facing README and a setup guide (`docs/SETUP.md`) are deliverables of Milestone 1, extended in Milestone 2: the copy-paste consumer snippet, the HTTP contract, and the operator checklist (Discord application, GitHub App, KV, secrets and variables, deploy). The guide must say that GitHub App names are globally unique, so a self-hoster picks their own name rather than "Nudge".
  Rationale: For a self-hosted template the guide is the install; a contract that lives only in this plan is not installable.
  Date/Author: 2026-09-23 / user, choosing the agent's recommendation.

- Decision (A17): TypeScript 7 with Oxlint and oxlint-tsgolint as the lint gate, configured in `oxlint.config.ts`. Kept from the ESLint gate: size and nesting limits, the type escape hatches (`any`, non-null assertions, `as` casts) as errors, the four type-aware rules, empty catch blocks, and `eslint-plugin-security` as a JS plugin. Lost: sonarjs `cognitive-complexity`, compensated by lowering cyclomatic `complexity` from 20 to 15; and `assertions-in-tests`, covered by the rule that every new test is first seen to fail. Rejected: TypeScript 6.0 with the full ESLint gate (keeps every rule, but pins the repository to the last JavaScript-API compiler and faces this choice again later).
  Rationale: The current compiler and a gate about ten times faster outweigh two rules that were the least load-bearing in the set; sonarjs cannot run under TypeScript 7 in either linter, so no TypeScript 7 option keeps it.
  Date/Author: 2026-09-23 / user, choosing the agent's recommendation.

- Decision (A18): Findings of the pre-merge review of pull request #1 (Codex second opinion plus the agent's own reading, 2026-09-24), and what was done with each. Fixed: (1) a token's `kid` is read before its signature, so junk tokens with unknown key ids could force a JWKS fetch from GitHub on every request; `src/jwks.ts` now attempts a fetch at most once per `JWKS_MIN_REFRESH_MS` (60 s), counting failed attempts too so a GitHub outage cannot turn a request flood into a fetch flood (found by the agent and by Codex's second pass), serves the last good key set inside that interval, and makes concurrent callers share one in-flight fetch; pinned by a flood test and by failure-path tests, each shown to fail when its guard is removed; (2) `deploy.yml` could be dispatched on any branch and deploy it with production credentials; the job now runs only for `refs/heads/main` and checks out `main`. Deferred, with reasons: (3) `actions/notify` has no automated test — Codex confirmed it is safe today (inputs pass through environment variables and `jq --arg`, the token is never logged, redirects are not followed); revisit when Milestone 2 adds three more actions, where a shared test harness pays for itself; (4) `ALLOWED_OWNERS` compares owner names, and a GitHub name can be released by a rename and re-registered by someone else — gating on the stable `repository_owner_id` claim is stronger but makes the setting unreadable, and Milestone 2 replaces this gate with the App-installation check (A15), which is keyed by installation, not name; (5) the Worker is also reachable on its `workers.dev` hostname, where the derived audience differs — a token minted for that audience still has to come from an allowed owner, so it grants nothing new; an operator who wants one hostname sets `NUDGE_AUDIENCE` or `workers_dev = false`.
  Rationale: Fix what an outsider can trigger or what reaches production credentials; defer what only a trusted owner can reach or what the next milestone removes anyway.
  Date/Author: 2026-09-24 / agent, from the review; the user asked for the review.


## Outcomes & Retrospective


Milestone 1 (accepted 2026-09-24). Every unattended weekly update in `gakumas-supportcards` now reports its outcome to Discord through a composite action, with no secret in that repository. All acceptance criteria were met: the real message, five refusals against production with real GitHub-signed tokens, and a second instance deployed from the same commit that only honours its own origin, which proves decision A13. The tooling that proved it, the Acceptance workflow and the `[env.acceptance]` instance, stays in the repository, so a self-hoster can prove the same about their instance (`docs/SETUP.md` § 7).

What went well. Designing for distribution before the first line of code (A12–A16) cost almost nothing, and the second-instance check showed it held. Pure modules with injected fetch, clock and key set let the whole Worker be tested end to end with self-signed keys before it was ever deployed. The Codex second opinion before merge found a real amplification bug that the agent had also spotted, and a deploy-from-any-branch hole that the agent had missed (A18).

What went wrong, and the lesson. (1) The first key-cache fix still let failed fetches through; only a second review pass and an adversarial re-read caught it. Rate limits belong on attempts, not successes. (2) The acceptance environment inherited the production custom domain; wrangler warned in the dry run, but a filtered output hid the warning, and only the user stopping at an interactive prompt kept production intact. Never filter a dry run's warnings out, and pin such configuration with a test (`src/wrangler-config.test.ts`). (3) Tooling friction cost more time than the code: TypeScript 7's missing JavaScript API forced a lint rethink (A17), and bun's install cache hung three times after interrupted installs.

Carried to Milestone 2: a test harness for the composite actions once there are four of them (A18, item 3); the owner gate is replaced by the App-installation check, which also retires the rename concern (A18, item 4).


## Context and Orientation


This repository was created on 2026-09-22 from `Taka499/project-template` and contains only `CLAUDE.md`, `docs/PLANS.md`, `docs/adr/` and this plan. Nothing described below exists yet.

Terms, in plain language. A Cloudflare Worker is a small program that runs at Cloudflare's edge and answers HTTPS requests; it is deployed with the `wrangler` command-line tool from a `wrangler.toml` file, and it can be bound to KV, Cloudflare's key-value store, for small persistent state. GitHub Actions is GitHub's workflow runner; a workflow is a YAML file under `.github/workflows/` in a repository. An OIDC token is a short-lived signed statement of identity that a workflow run can request from GitHub, saying which repository, branch, commit and run it is; anyone holding GitHub's public keys can verify it. A `repository_dispatch` is an event a caller with permission can send to a repository to start a workflow that declares `on: repository_dispatch`, carrying a free-form JSON payload. A GitHub App is an identity GitHub grants permissions to per repository ("installed" on the repository); it signs a short JWT with its private key to obtain a one-hour token for one installation. Discord is the chat application; a webhook URL lets anyone who holds it post messages into one channel; a Discord application with a bot can also put buttons on messages and receives a signed HTTP request at its Interactions Endpoint URL whenever someone presses one.

The two consumers today. `tia-tools/gakumas-supportcards` (a local checkout is usually at `../gakumas-supportcards`) runs `.github/workflows/update-data.yml` weekly: it regenerates data, merges its own pull request when its gates pass, opens or refreshes an issue labelled `held-cards` for cards it cannot score, and leaves a pull request open for a person only when the merge is refused. It wants `notify` for the run's outcome and `request` for the held-card case once its pipeline can draft a proposal. `Taka499/ss-assist` (usually at `../ss-assist`) runs `.github/workflows/auto-character.yml` weekly, opening a pull request from branch `auto/sync-data` into `develop` with a new character's data and icon; a person reviews it, and `promote-to-main.yml` then opens a pull request from `develop` into `main`, which deploys on merge. It wants `request` with the character's icon, and its dispatch handler will merge into `develop` and promote (A7).

The reference for a Worker that calls GitHub's API with a stored token and validates its input strictly is `gakumas-rehearsal-automation/infra/worker/worker.js`, function `feedback`. The reference for how a tia-tools app is deployed — a custom-domain route in `wrangler.toml`, a deploy workflow gated on tests, an account-owned Cloudflare API token with the Editor role on one Worker — is `gakumas-supportcards/.github/workflows/deploy.yml` and `gakumas-supportcards/infra/worker/README.md`.


## Plan of Work


Milestone 1 builds `notify`. `src/worker.ts` routes `POST /notify`; `src/oidc.ts` verifies the bearer token (issuer `https://token.actions.githubusercontent.com`, audience equal to the instance's own origin per A13, signature against the JWKS fetched from GitHub and cached, expiry) and returns the claims; the Worker then refuses with 403 any repository whose owner is not in `ALLOWED_OWNERS` (A15); `src/discord.ts` posts to the channel webhook a message whose first line is the repository name and a link to the run. Everything that decides — whether a token is acceptable, how a message is composed — is a pure function with tests; the fetches are at the edges. `.github/workflows/deploy.yml` deploys `main` after tests, following the gakumas-supportcards one. `actions/notify/action.yml` is a composite action that requests the OIDC token for the `endpoint` input's origin and posts the body (A14); the README and `docs/SETUP.md` carry the consumer snippet and the operator checklist (A16); the `v1` tag is created on the first release. `gakumas-supportcards` then gains a final step in its update workflow using `Taka499/nudge/actions/notify@v1` to post the outcome, and a `notify` when the held list is non-empty.

Milestone 2 adds `POST /request` (same authentication; body with title, body text, optional URL, the commit, an optional image URL; the Worker posts a message with Approve and Decline buttons via the bot, stores `{repo, commit, run, createdAt, messageId, status}` in KV under a random id, returns the id), `POST /interactions` (verifies Discord's Ed25519 signature; answers PING; on a button press applies the tap rules of A5, acknowledges with a deferred update, mints an installation token for the repository through the GitHub App, sends `repository_dispatch` with `event_type` `nudge-approved` or `nudge-declined` and `client_payload {id, commit, actor}`, marks the request answered, and edits the message), and `POST /resolve` (authenticated like `notify`; marks the outcome and edits the message). The owner gate of Milestone 1 is replaced by the installation check (A15): the Worker lists the App's installations (cached) and refuses a repository the App is not installed on. `actions/request`, `actions/resolve` and `actions/guard` join `actions/notify` (A14), and the setup guide gains the Discord application and GitHub App sections. Then the two consumers gain a workflow `on: repository_dispatch` that runs `actions/guard` to check the pull request's head against the payload's commit and acts.

Milestone 3 adds `.github/workflows/check-cloudflare-token.yml` with `on: workflow_call`, taking the token as a secret input, calling `GET https://api.cloudflare.com/client/v4/user/tokens/verify` (or the account-token equivalent) for the expiry, and posting a `notify` to the `endpoint` input when it is within 30 days (A14). `gakumas-supportcards` calls it weekly.

Milestone 4 is deferred and not scheduled: a hosted instance serving several owners would key channel, allowlist and KV state per GitHub App installation. It is listed only so that Milestones 1–3 keep the properties (A13, A15) that make it a configuration layer rather than a rewrite.


## Concrete Steps


Before Milestone 1, by the user: create a private Discord server (or a private channel in an existing one), add a webhook to the channel and copy its URL; in the tia-tools Cloudflare account create an account-owned API token for this Worker's deploy workflow (Editor on the Worker `nudge`, Workers Routes on `tia.run`); store `DISCORD_WEBHOOK_URL` as a Worker secret (`bunx wrangler secret put DISCORD_WEBHOOK_URL`), set `ALLOWED_OWNERS` (and `NUDGE_AUDIENCE` if the request origin is not to be trusted) as `wrangler` variables, and the Cloudflare token and account id as repository secrets.

Before Milestone 2, by the user: in the Discord developer portal create an application "Nudge", copy its public key and application id, add a bot, invite it to the server with permission to send messages in the channel, and set the Interactions Endpoint URL to `https://nudge.tia.run/interactions` (Discord tests it with a PING at that moment, so Milestone 2's endpoint must be deployed first); under the `Taka499` account create a GitHub App "Nudge" (App names are unique across GitHub; a self-hoster picks another name, A16) with the repository permission Contents: read and write (needed for `repository_dispatch`), generate a private key, note the app id, and install it on `tia-tools/gakumas-supportcards` and `Taka499/ss-assist`; create a KV namespace; record the Discord user id(s) allowed to approve.

Commands, as run on 2026-09-23 for Milestone 1 (transcripts abridged):

    bun add -d typescript @types/bun wrangler    # typescript 7.0.2, @types/bun 1.4.2, wrangler 4.136.2
    bun test                                     # 48 pass, 0 fail, 184 expect() calls, 6 files
    bun run type-check                           # clean
    bun add -d eslint typescript-eslint eslint-plugin-sonarjs eslint-plugin-security @eslint/js typescript@^5.9
    bun run lint                                 # clean after draining 25 findings (see Surprises)
    bun remove eslint typescript-eslint eslint-plugin-sonarjs @eslint/js     # decision A17
    bun add -d typescript@~7.0.2 oxlint@^1.85.0 oxlint-tsgolint@^7.0.2002
    bun run type-check                           # clean under TypeScript 7.0.2
    bun run lint                                 # oxlint --deny-warnings: clean; exit 1 with an injected `any`
    bun run deploy:check                         # wrangler deploy --dry-run --outdir "$TMPDIR/wrangler-out"; 11.97 KiB, one binding ALLOWED_OWNERS


## Validation and Acceptance


Milestone 1 is accepted when a manual run of a workflow in `gakumas-supportcards` produces a message in the Discord channel that names the repository and links to the run, and when the same request replayed with a token for a different audience, an expired token, or no token is refused with 401 and produces no message; a valid token from a repository whose owner is not in `ALLOWED_OWNERS` is refused with 403 and produces no message; and `gakumas-supportcards` reaches the endpoint through `actions/notify@v1`, not a hand-written step. Self-hosting is accepted when a second Worker deployed from the same commit onto a `workers.dev` hostname, with its own variables and a different audience, accepts a consumer that names it as `endpoint` and refuses one that carries a token for `nudge.tia.run`; this is the test that no tenant constant leaked into the code (A13).

Milestone 2 is accepted when a request from `gakumas-supportcards` shows Approve and Decline buttons in Discord; a tap by the allowlisted user starts the repository's dispatch workflow, which merges the named pull request and reports back, after which the message shows "merged" and the buttons are gone; a second tap on the same message changes nothing; a tap from a non-allowlisted account is ignored; and a request older than 7 days is answered as expired. A valid token from a repository the GitHub App is not installed on is refused with 403 (A15), and a dispatch whose commit no longer matches the pull request's head is stopped by `actions/guard` before anything acts.

Milestone 3 is accepted when a consuming repository's weekly call posts nothing for a token more than 30 days from expiry and posts a warning naming the repository and the date for one within 30 days.


## Idempotence and Recovery


Every deploy is idempotent. A `request` is single-use by construction, so a repeated tap cannot repeat a dispatch; a repository's dispatch handler must also be safe to run twice, which checking the pull request's head against the pinned commit ensures. If KV loses a request, the button answers "unknown request" and the person acts on GitHub as before Nudge existed. Nothing in this repository can modify a consumer beyond what the consumer's own workflow does.


## Artifacts and Notes


The design interview of 2026-09-22 is transcribed into the Decision Log above; the scratch log it was kept in during the session added nothing beyond it.


## Interfaces and Dependencies


Runtime: Bun for tests and scripts, `wrangler` for deployment, TypeScript. No framework. The Discord and GitHub calls use `fetch` directly.

Consumer contract, all requests `Content-Type: application/json` with `Authorization: Bearer <GitHub OIDC token, audience = the instance's origin, e.g. https://nudge.tia.run>` (A13); a repository not covered by `ALLOWED_OWNERS` (Milestone 1) or by an installation of the instance's GitHub App (Milestone 2 on) receives 403 (A15):

    POST /notify   { title: string, body: string, url?: string }                       -> 204
    POST /request  { title: string, body: string, url?: string, commit: string, image?: string }  -> 201 { id: string }
    POST /resolve  { id: string, outcome: "merged" | "failed" | "declined", detail?: string }     -> 204
    POST /interactions   (Discord only; Ed25519-signed)

Dispatch to the consumer: `event_type` `nudge-approved` or `nudge-declined`, `client_payload` `{ id, commit, actor }` where `actor` is the Discord user id that tapped.

Composite actions (A14), referenced as `Taka499/nudge/actions/<name>@v1`; every one takes `endpoint` (the instance origin) and requests the OIDC token itself, so the calling job needs `permissions: id-token: write`:

    actions/notify    inputs: endpoint, title, body, url?
    actions/request   inputs: endpoint, title, body, url?, commit, image?      outputs: id
    actions/resolve   inputs: endpoint, id, outcome, detail?
    actions/guard     inputs: commit (from client_payload), pull-request        fails the job when the head differs

Reusable workflow `.github/workflows/check-cloudflare-token.yml`: `on: workflow_call` with input `endpoint` and secret `cloudflare-token`.

Instance configuration (`wrangler.toml` variables and secrets, A13): `NUDGE_AUDIENCE?`, `ALLOWED_OWNERS` (Milestone 1), `DISCORD_WEBHOOK_URL`, and from Milestone 2 `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_ALLOWED_USERS`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and the KV binding `REQUESTS`.

In `src/oidc.ts`:

    export interface WorkflowIdentity { repository: string; sha: string; runId: string; ref: string }
    export function verifyGithubToken(token: string, audience: string, jwks: JsonWebKeySet, now: Date): Promise<WorkflowIdentity>;

In `src/discord.ts`, pure message builders `notifyMessage(identity, input)` and `requestMessage(identity, input, id)` returning the JSON Discord expects, and a thin `post`.


## Revision notes


- 2026-09-22: Created at scaffold time from the grill-me session's decisions A1–A11 and the facts gathered before it.
- 2026-09-23: Decisions A12–A16 (self-hosted distribution, no tenant constant, composite actions, registration by App installation, setup guide) after a review of the roadmap against future install and distribution; Milestones 1–3 amended, Milestone 4 listed as deferred, acceptance and interfaces extended, `docs/adr/0002` amended.
- 2026-09-23: Decision A17 (TypeScript 7 with Oxlint and tsgolint as the lint gate) and three Surprises entries from building the gate.
- 2026-09-24: Decision A18 (pre-merge review findings); Milestone 1 accepted and `v1` tagged; Progress, Outcomes & Retrospective updated.
