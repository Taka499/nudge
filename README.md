# Nudge

Nudge lets a GitHub Actions workflow post to a private Discord channel with no secret stored in the repository: a plain notification today (`notify`), and, from Milestone 2, a question with Approve and Decline buttons (`request`) whose outcome the repository reports back (`resolve`). A tap on Approve sends a `repository_dispatch` to the repository, and the repository's own committed workflow acts. Nudge never merges, deploys or edits anything itself (`docs/adr/0001`).

It is a small Cloudflare Worker plus the GitHub Actions that call it. Nudge is a **self-hosted template**: you deploy your own Worker from this repository, and your repositories talk to your instance. `https://nudge.tia.run` is the author's instance and serves only the author's repositories. Setting up an instance takes about half an hour: `docs/SETUP.md`.

## Use it from a workflow

The job needs `id-token: write`. The action requests a short-lived GitHub OIDC token for your instance and sends it as the bearer token; the instance verifies it against GitHub's public keys (`docs/adr/0002`) and refuses repositories it does not serve.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: Taka499/nudge/actions/notify@v1
    if: always()
    with:
      endpoint: https://nudge.tia.run          # your instance
      title: "Weekly update: ${{ job.status }}"
      body: |
        12 cards changed, 0 held.
      url: ${{ github.server_url }}/${{ github.repository }}/pull/42   # optional; defaults to this run
```

The message in Discord starts with the repository name, then the title linked to the URL, the body, and a footer with the branch, short commit and run id.

The `v1` tag is created at the first release (Milestone 1 acceptance) and only ever moves to compatible changes; a breaking change gets `v2`.

## HTTP contract

Every request is `POST` with `Content-Type: application/json` and `Authorization: Bearer <GitHub OIDC token>`. The token's audience must be the instance origin, for example `https://nudge.tia.run`; the action does this for you.

| Call | Body | Answer |
|---|---|---|
| `POST /notify` | `{ "title": string, "body": string, "url"?: string }` | `204` |
| `POST /request` | Milestone 2 | |
| `POST /resolve` | Milestone 2 | |

Errors carry `{ "error": string }`:

| Status | Meaning |
|---|---|
| 400 | body is not valid JSON, or `title`/`body` missing or empty, or `url` not http(s) |
| 401 | no bearer token, or the token is malformed, expired, for another audience, another issuer, or signed by an unknown key |
| 403 | the repository's owner is not served by this instance |
| 413 | body larger than 64 KiB |
| 415 | `Content-Type` is not `application/json` |
| 500 | the instance has no Discord webhook configured |
| 502 | Discord refused the message |
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

Layout: `src/oidc.ts` verifies tokens, `src/jwks.ts` caches GitHub's keys, `src/gate.ts` is the owner allowlist, `src/validate.ts` checks bodies, `src/discord.ts` builds and posts messages, `src/worker.ts` routes. `actions/` holds the composite actions consumers call. `wrangler.toml` is the instance configuration. Design, milestones and every decision: `docs/plans/EXECPLAN_NUDGE.md`.
