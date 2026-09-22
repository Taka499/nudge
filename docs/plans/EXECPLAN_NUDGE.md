# Nudge: notifications and one-tap approvals from GitHub Actions to Discord

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This document must be maintained in accordance with `docs/PLANS.md` at the repository root.

Design confirmed by the user on 2026-09-22 in a grill-me session held in the `gakumas-supportcards` repository; implementation has not started.


## Purpose / Big Picture


Automated workflows in the user's repositories increasingly do things without a person watching: `gakumas-supportcards` regenerates its card data every week and publishes it by itself, and `ss-assist` detects new game characters and opens a pull request with their data and icon. When such a run needs a human — a card it cannot score, a character whose icon must be looked at, a deploy token about to expire — the only channel today is GitHub email, which the user reads least. Nudge is a small Cloudflare Worker at `https://nudge.tia.run` that any of the user's GitHub Actions workflows can call to post a message into one private Discord channel, and, when the message asks a question, to carry Approve and Decline buttons. A tap on Approve does not merge anything: Nudge sends a `repository_dispatch` event back to the repository, and the repository's own committed workflow performs the action (`docs/adr/0001`). The repository then reports the outcome and Nudge edits the message to say merged, failed or declined.

After this plan, the user sees every unattended run's outcome as a Discord push, approves a held card or a new character from the lock screen with one tap, and gets a reminder a month before a Cloudflare token expires, without any repository storing a secret for Nudge (`docs/adr/0002`).


## Progress


- [x] (2026-09-22) Design interview (grill-me, in `gakumas-supportcards`): decisions A1–A11 below; repository scaffolded from `Taka499/project-template@b52b8df`; ADRs 0001 and 0002 written.
- [ ] User-side setup (see Concrete Steps § Before Milestone 1): Discord server, channel and webhook; the Cloudflare account-owned token for this Worker's own deploy.
- [ ] Milestone 1: `notify`. OIDC verification, Discord webhook post, deploy workflow; `gakumas-supportcards` posts its weekly update outcomes and held-cards notices.
- [ ] User-side setup for Milestone 2: Discord application (public key, bot, interactions endpoint URL); GitHub App "Nudge" (private key, app id, installed on `tia-tools/gakumas-supportcards` and `Taka499/ss-assist`); a KV namespace; the Discord user-id allowlist.
- [ ] Milestone 2: `request` and `resolve`. Buttons, the interactions endpoint with Ed25519 verification, request state in KV, the allowlist and tap rules, the GitHub App and `repository_dispatch`; `gakumas-supportcards` and `ss-assist` consume it.
- [ ] Milestone 3: the reusable Cloudflare token-expiry workflow, called weekly by consuming repositories.


## Surprises & Discoveries


- Observation: Discord lets a plain webhook message carry buttons (Execute Webhook accepts `components`), but a button press is delivered only to an application's Interactions Endpoint URL, signed with Ed25519 (`X-Signature-Ed25519`, `X-Signature-Timestamp`), and Discord removes an endpoint that fails to validate signatures. So Milestone 1 needs only a webhook URL, while Milestone 2 needs a Discord application with a public key and an HTTPS endpoint that answers a type-1 PING with a PONG.
  Evidence: Discord developer documentation, "Receiving and Responding" and "Hosting on Cloudflare Workers", read 2026-09-22.

- Observation: A GitHub App mints an installation token by signing a JWT with its private key and calling `POST /app/installations/{id}/access_tokens`; the token lives one hour and can be restricted at mint time to specific repositories and permissions. This is what makes A2 cheap: no long-lived token exists anywhere.
  Evidence: GitHub documentation, "Generating an installation access token for a GitHub App", read 2026-09-22.

- Observation: ss-assist today has two human checkpoints — reviewing the bot's pull request into `develop` (faction, icon, localised names) and merging the automatic promotion pull request into `main`, which deploys — while `gakumas-supportcards` merges its own routine update and leaves a pull request open only when the merge is refused. Nudge must serve both shapes, which is why the action on Approve belongs to the repository (A1) and not to Nudge.
  Evidence: `ss-assist/.github/workflows/{auto-character,promote-to-main}.yml` and `gakumas-supportcards/.github/workflows/update-data.yml`, read 2026-09-22.


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


## Outcomes & Retrospective


Nothing to report yet.


## Context and Orientation


This repository was created on 2026-09-22 from `Taka499/project-template` and contains only `CLAUDE.md`, `docs/PLANS.md`, `docs/adr/` and this plan. Nothing described below exists yet.

Terms, in plain language. A Cloudflare Worker is a small program that runs at Cloudflare's edge and answers HTTPS requests; it is deployed with the `wrangler` command-line tool from a `wrangler.toml` file, and it can be bound to KV, Cloudflare's key-value store, for small persistent state. GitHub Actions is GitHub's workflow runner; a workflow is a YAML file under `.github/workflows/` in a repository. An OIDC token is a short-lived signed statement of identity that a workflow run can request from GitHub, saying which repository, branch, commit and run it is; anyone holding GitHub's public keys can verify it. A `repository_dispatch` is an event a caller with permission can send to a repository to start a workflow that declares `on: repository_dispatch`, carrying a free-form JSON payload. A GitHub App is an identity GitHub grants permissions to per repository ("installed" on the repository); it signs a short JWT with its private key to obtain a one-hour token for one installation. Discord is the chat application; a webhook URL lets anyone who holds it post messages into one channel; a Discord application with a bot can also put buttons on messages and receives a signed HTTP request at its Interactions Endpoint URL whenever someone presses one.

The two consumers today. `tia-tools/gakumas-supportcards` (a local checkout is usually at `../gakumas-supportcards`) runs `.github/workflows/update-data.yml` weekly: it regenerates data, merges its own pull request when its gates pass, opens or refreshes an issue labelled `held-cards` for cards it cannot score, and leaves a pull request open for a person only when the merge is refused. It wants `notify` for the run's outcome and `request` for the held-card case once its pipeline can draft a proposal. `Taka499/ss-assist` (usually at `../ss-assist`) runs `.github/workflows/auto-character.yml` weekly, opening a pull request from branch `auto/sync-data` into `develop` with a new character's data and icon; a person reviews it, and `promote-to-main.yml` then opens a pull request from `develop` into `main`, which deploys on merge. It wants `request` with the character's icon, and its dispatch handler will merge into `develop` and promote (A7).

The reference for a Worker that calls GitHub's API with a stored token and validates its input strictly is `gakumas-rehearsal-automation/infra/worker/worker.js`, function `feedback`. The reference for how a tia-tools app is deployed — a custom-domain route in `wrangler.toml`, a deploy workflow gated on tests, an account-owned Cloudflare API token with the Editor role on one Worker — is `gakumas-supportcards/.github/workflows/deploy.yml` and `gakumas-supportcards/infra/worker/README.md`.


## Plan of Work


Milestone 1 builds `notify`. `src/worker.ts` routes `POST /notify`; `src/oidc.ts` verifies the bearer token (issuer `https://token.actions.githubusercontent.com`, audience `nudge.tia.run`, signature against the JWKS fetched from GitHub and cached, expiry) and returns the claims; `src/discord.ts` posts to the channel webhook a message whose first line is the repository name and a link to the run. Everything that decides — whether a token is acceptable, how a message is composed — is a pure function with tests; the fetches are at the edges. `.github/workflows/deploy.yml` deploys `main` after tests, following the gakumas-supportcards one. `gakumas-supportcards` then gains a final step in its update workflow that posts the outcome, and a `notify` when the held list is non-empty.

Milestone 2 adds `POST /request` (same authentication; body with title, body text, optional URL, the commit, an optional image URL; the Worker posts a message with Approve and Decline buttons via the bot, stores `{repo, commit, run, createdAt, messageId, status}` in KV under a random id, returns the id), `POST /interactions` (verifies Discord's Ed25519 signature; answers PING; on a button press applies the tap rules of A5, acknowledges with a deferred update, mints an installation token for the repository through the GitHub App, sends `repository_dispatch` with `event_type` `nudge-approved` or `nudge-declined` and `client_payload {id, commit, actor}`, marks the request answered, and edits the message), and `POST /resolve` (authenticated like `notify`; marks the outcome and edits the message). Then the two consumers gain a workflow `on: repository_dispatch` that checks the pull request's head against the payload's commit and acts.

Milestone 3 adds `.github/workflows/check-cloudflare-token.yml` with `on: workflow_call`, taking the token as a secret input, calling `GET https://api.cloudflare.com/client/v4/user/tokens/verify` (or the account-token equivalent) for the expiry, and posting a `notify` when it is within 30 days. `gakumas-supportcards` calls it weekly.


## Concrete Steps


Before Milestone 1, by the user: create a private Discord server (or a private channel in an existing one), add a webhook to the channel and copy its URL; in the tia-tools Cloudflare account create an account-owned API token for this Worker's deploy workflow (Editor on the Worker `nudge`, Workers Routes on `tia.run`); store `DISCORD_WEBHOOK_URL` as a Worker secret (`bunx wrangler secret put DISCORD_WEBHOOK_URL`) and the Cloudflare token and account id as repository secrets.

Before Milestone 2, by the user: in the Discord developer portal create an application "Nudge", copy its public key and application id, add a bot, invite it to the server with permission to send messages in the channel, and set the Interactions Endpoint URL to `https://nudge.tia.run/interactions` (Discord tests it with a PING at that moment, so Milestone 2's endpoint must be deployed first); under the `Taka499` account create a GitHub App "Nudge" with the repository permission Contents: read and write (needed for `repository_dispatch`), generate a private key, note the app id, and install it on `tia-tools/gakumas-supportcards` and `Taka499/ss-assist`; create a KV namespace; record the Discord user id(s) allowed to approve.

Commands, to be filled in with real transcripts as milestones run:

    bun install
    bun test
    bun run type-check
    bunx wrangler deploy --dry-run --outdir "$TMPDIR/wrangler-out"


## Validation and Acceptance


Milestone 1 is accepted when a manual run of a workflow in `gakumas-supportcards` produces a message in the Discord channel that names the repository and links to the run, and when the same request replayed with a token for a different audience, an expired token, or no token is refused with 401 and produces no message.

Milestone 2 is accepted when a request from `gakumas-supportcards` shows Approve and Decline buttons in Discord; a tap by the allowlisted user starts the repository's dispatch workflow, which merges the named pull request and reports back, after which the message shows "merged" and the buttons are gone; a second tap on the same message changes nothing; a tap from a non-allowlisted account is ignored; and a request older than 7 days is answered as expired.

Milestone 3 is accepted when a consuming repository's weekly call posts nothing for a token more than 30 days from expiry and posts a warning naming the repository and the date for one within 30 days.


## Idempotence and Recovery


Every deploy is idempotent. A `request` is single-use by construction, so a repeated tap cannot repeat a dispatch; a repository's dispatch handler must also be safe to run twice, which checking the pull request's head against the pinned commit ensures. If KV loses a request, the button answers "unknown request" and the person acts on GitHub as before Nudge existed. Nothing in this repository can modify a consumer beyond what the consumer's own workflow does.


## Artifacts and Notes


The design interview of 2026-09-22 is transcribed into the Decision Log above; the scratch log it was kept in during the session added nothing beyond it.


## Interfaces and Dependencies


Runtime: Bun for tests and scripts, `wrangler` for deployment, TypeScript. No framework. The Discord and GitHub calls use `fetch` directly.

Consumer contract, all requests `Content-Type: application/json` with `Authorization: Bearer <GitHub OIDC token, audience nudge.tia.run>`:

    POST /notify   { title: string, body: string, url?: string }                       -> 204
    POST /request  { title: string, body: string, url?: string, commit: string, image?: string }  -> 201 { id: string }
    POST /resolve  { id: string, outcome: "merged" | "failed" | "declined", detail?: string }     -> 204
    POST /interactions   (Discord only; Ed25519-signed)

Dispatch to the consumer: `event_type` `nudge-approved` or `nudge-declined`, `client_payload` `{ id, commit, actor }` where `actor` is the Discord user id that tapped.

In `src/oidc.ts`:

    export interface WorkflowIdentity { repository: string; sha: string; runId: string; ref: string }
    export function verifyGithubToken(token: string, audience: string, jwks: JsonWebKeySet, now: Date): Promise<WorkflowIdentity>;

In `src/discord.ts`, pure message builders `notifyMessage(identity, input)` and `requestMessage(identity, input, id)` returning the JSON Discord expects, and a thin `post`.


## Revision notes


- 2026-09-22: Created at scaffold time from the grill-me session's decisions A1–A11 and the facts gathered before it.
