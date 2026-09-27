# Nudge

Nudge lets a GitHub Actions workflow post to a private Discord channel with no secret stored in the repository: a plain notification (`notify`), and a question with Approve and Decline buttons (`request`) whose outcome the repository reports back (`resolve`). A tap on Approve sends a `repository_dispatch` to the repository, and the repository's own committed workflow acts. Nudge never merges, deploys or edits anything itself (`docs/adr/0001`).

It is a small Cloudflare Worker plus the GitHub Actions that call it. Nudge is a **self-hosted template**: you deploy your own Worker from this repository, and your repositories talk to your instance. `https://nudge.tia.run` is the author's instance and serves only the author's repositories. Setting up an instance takes about half an hour: `docs/SETUP.md`.

## Use it from a workflow

The job needs `id-token: write`. The action requests a short-lived GitHub OIDC token for your instance and sends it as the bearer token; the instance verifies it against GitHub's public keys (`docs/adr/0002`) and refuses repositories it does not serve.

Give the notification a job of its own, after the job that does the work:

```yaml
jobs:
  update:
    # ... the job that does the work, with whatever permissions and secrets it needs

  notify:
    needs: update
    if: always()
    runs-on: ubuntu-latest
    permissions:
      id-token: write                            # nothing else: no secrets, no environment
    steps:
      - uses: Taka499/nudge/actions/notify@d9f7f1ac185050506d526532a0e24861564422cf # v1.1.0
        with:
          endpoint: https://nudge.tia.run          # your instance
          title: "Weekly update: ${{ needs.update.result }}"
          body: |
            12 cards changed, 0 held.
          url: ${{ github.server_url }}/${{ github.repository }}/pull/42   # optional; defaults to this run
```

The message in Discord starts with the repository name, then the title linked to the URL, the body, and a footer with the branch, short commit and run id.

### Pin by commit hash

The action runs inside your job, with your job's permissions. `id-token: write` lets any code in the job obtain an OIDC token that names *your* repository, for any audience — including a cloud provider or package registry that trusts your repository's tokens. A tag such as `v1` can be moved by whoever controls this repository, and your workflow would run the new code on its next run without any change on your side. A 40-character commit hash cannot change. That is why the snippet pins a hash, with the version as a comment (`docs/adr/0003`).

The separate job limits the damage if the action were ever compromised: its token carries no deployment environment, so a cloud trust policy that requires one refuses it, and no secrets of the working job are in reach.

Keep the pin current with Dependabot. It opens a pull request that changes the hash and the version comment together when a new version is released:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Versions. Every exact version (`v1.0.0`, `v1.1.0`, …) is a GitHub Release, and this repository has immutable releases enabled, so a version's tag can never be moved to other code; pick the one that matches the Worker you deployed. `v1` is a plain tag moved to each compatible version — compatible also with Workers deployed from earlier `v1` versions; a breaking change gets `v2`. `@v1` works if you accept following a movable tag, but it is not the recommended form. The actions contain no nested `uses:`, so pinning one pins all the code it runs (enforced by `src/pinning.test.ts`).

## Ask for an approval

A `request` is a message with Approve and Decline buttons. It names the exact commit a tap approves, so raise one whenever the pull request is created *or updated*: an older message can only ever come back as stale. The job that raises it needs only `id-token: write`, like `notify`.

```yaml
  ask:
    needs: sync                                   # the job that opened or updated the pull request
    if: needs.sync.outputs.head != ''
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: Taka499/nudge/actions/request@d9f7f1ac185050506d526532a0e24861564422cf # v1.1.0
        with:
          endpoint: https://nudge.tia.run          # your instance
          title: "New character: ${{ needs.sync.outputs.name }}"
          body: "Approve to merge into develop and promote to main."
          url: ${{ needs.sync.outputs.pull-request-url }}
          commit: ${{ needs.sync.outputs.head }}   # the pull request's head sha, 40 characters
          image: ${{ needs.sync.outputs.icon-url }} # optional
```

A tap sends a `repository_dispatch` to the repository with `event_type` `nudge-approved` or `nudge-declined` and `client_payload` `{ id, commit, actor }`. The repository's own committed workflow does the work; Nudge never merges (`docs/adr/0001`). The handler runs in a fresh workflow run, possibly days later, so it starts with `guard`, which finds the one open pull request whose head is still that commit and stops otherwise, with its `stale` output set; a lookup that failed for another reason (GitHub down) stops without it, so the report says `failed`, not `stale`. It merges with `--match-head-commit`, which makes GitHub refuse if the head moved in between, and it reports back with `resolve` on every exit path, in a job of its own with only `id-token: write`:

```yaml
name: Approved from Discord

on:
  repository_dispatch:
    types: [nudge-approved]

permissions:
  contents: write
  pull-requests: write

jobs:
  merge:
    runs-on: ubuntu-latest
    outputs:
      stale: ${{ steps.guard.outputs.stale }}
      number: ${{ steps.guard.outputs.pull-request }}
    steps:
      - id: guard
        uses: Taka499/nudge/actions/guard@d9f7f1ac185050506d526532a0e24861564422cf # v1.1.0
        with:
          commit: ${{ github.event.client_payload.commit }}
      - run: gh pr merge "$NUMBER" --merge --match-head-commit "$COMMIT"
        env:
          GH_TOKEN: ${{ github.token }}
          NUMBER: ${{ steps.guard.outputs.pull-request }}
          COMMIT: ${{ github.event.client_payload.commit }}

  report:
    needs: merge
    if: always()
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: Taka499/nudge/actions/resolve@d9f7f1ac185050506d526532a0e24861564422cf # v1.1.0
        with:
          endpoint: https://nudge.tia.run
          id: ${{ github.event.client_payload.id }}
          outcome: ${{ needs.merge.result == 'success' && 'done' || (needs.merge.outputs.stale == 'true' && 'stale' || 'failed') }}
          detail: ${{ needs.merge.result == 'success' && format('merged #{0}', needs.merge.outputs.number) || 'see the run' }}
```

`resolve` is the repository's final word, not proof that a tap happened: it is what the message shows from then on, and it removes the buttons. A `nudge-declined` handler is optional; the message already says who declined.

The three actions:

    actions/request   inputs: endpoint, title, body, url?, commit, image?      outputs: id
    actions/resolve   inputs: endpoint, id, outcome (done | failed | stale), detail?
    actions/guard     inputs: commit, token?                                    outputs: pull-request, stale

Every action's bash step runs against faked `curl` and `gh` in `src/actions.test.ts`, so the audience, path, body and accepted status are pinned by tests.

## HTTP contract

Every request is `POST` with `Content-Type: application/json` and `Authorization: Bearer <GitHub OIDC token>`. The token's audience must be the instance origin, for example `https://nudge.tia.run`; the action does this for you.

| Call | Body | Answer |
|---|---|---|
| `POST /notify` | `{ "title": string, "body": string, "url"?: string }` | `204` |
| `POST /request` | `{ "title": string, "body": string, "url"?: string, "commit": string, "image"?: string }` | `201 { "id": string }` |
| `POST /resolve` | `{ "id": string, "outcome": "done" \| "failed" \| "stale", "detail"?: string }` | `204` |
| `POST /interactions` | Discord only: Ed25519-signed button presses | |

A `request` posts the same message as `notify` plus Approve and Decline buttons, the repository as the embed's author, and the optional image. `commit` is the full 40-character sha the tap will approve; a consumer's dispatch handler acts on that commit and nothing newer. The answer's `id` is the Discord message id. A tap by an allowed Discord user sends `repository_dispatch` to the repository with `event_type` `nudge-approved` or `nudge-declined` and `client_payload` `{ "id", "commit", "actor" }`, where `actor` is the Discord user id; the message is then edited to say who answered. A tap by anyone else, on an answered message, or on a message older than 7 days changes nothing on GitHub.

A `resolve` is the repository reporting what its dispatch handler did: the message is edited to show the outcome word and the detail ("done: merged #42, promoted to main") and loses its buttons. `stale` is what a handler reports when the pull request's head no longer matches the commit that was approved. Only the repository the message names may resolve it.

Errors carry `{ "error": string }`:

| Status | Meaning |
|---|---|
| 400 | body is not valid JSON, or `title`/`body` missing or empty, or `url`/`image` not http(s), or `commit` not a full lowercase sha; on `/resolve`, `id` not a message id, `outcome` not one of the three, or `detail` blank |
| 401 | no bearer token, or the token is malformed, expired, for another audience, another issuer, or signed by an unknown key; on `/interactions`, a bad Discord signature or a timestamp more than five minutes from now |
| 403 | the repository's owner is not served by this instance; on `/resolve`, the request belongs to another repository |
| 404 | on `/resolve`, no message has that id, or the message is not a request |
| 413 | body larger than 64 KiB |
| 415 | `Content-Type` is not `application/json` |
| 500 | the instance has no Discord bot token or channel id configured |
| 502 | Discord refused the message (a 429 is retried once after the wait it asks for, up to 5 s), or answered without a message id |
| 503 | GitHub's signing keys could not be fetched |

Titles longer than 256 characters and bodies longer than 4096 are truncated with an ellipsis, not refused. Mentions in the body never ping anyone.

## Develop

```
bun install
bun test               # every rule is a pure function with tests; the Worker is driven end to end with self-signed tokens
bun run type-check
bun run lint           # Oxlint + tsgolint: size, complexity and type-escape rules are errors; exceptions live in oxlint.config.ts only
bun run deploy:check   # wrangler dry run: builds the Worker without an account
```

Layout: `src/oidc.ts` verifies tokens, `src/jwks.ts` caches GitHub's keys, `src/gate.ts` is the owner allowlist, `src/validate.ts` checks bodies, `src/discord.ts` builds messages and posts and edits them through the bot, `src/interactions.ts` verifies and reads button presses, `src/github-app.ts` signs the App JWT and sends the dispatch, `src/worker.ts` routes. `actions/` holds the composite actions consumers call, each run for real against faked `curl` and `gh` by `src/actions.test.ts`. `.dev.vars.example` lists the instance values, which are Worker secrets loaded from a gitignored copy (`docs/adr/0004`); `wrangler.toml` names no tenant. Design, milestones and every decision: `docs/plans/EXECPLAN_NUDGE.md`.
