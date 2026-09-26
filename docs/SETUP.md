# Setting up a Nudge instance

Nudge is self-hosted: one Cloudflare Worker per person or team, serving that owner's repositories (plan decision A12 in `docs/plans/EXECPLAN_NUDGE.md`). This guide takes an operator from a clone to a working `notify` in about half an hour. Nothing tracked in the repository names your instance: the code names no hostname, owner or channel (A13), and `wrangler.toml` holds no value of yours either. Every instance value is a Worker secret that you load from one local, gitignored file (`docs/adr/0004`), so a fork never edits a tracked file and pulls upstream cleanly.

You need: a Cloudflare account (the free plan is enough, and no domain: every Worker gets a free `<name>.<account>.workers.dev` hostname), a Discord server where you can manage webhooks, and a GitHub account or organisation whose repositories will call the instance.

## 1. Clone and fill in the instance file

Fork or clone `Taka499/nudge`, then:

    bun install
    cp .dev.vars.example .dev.vars

Edit `.dev.vars` (gitignored; keep it, it is the readable copy of your instance):

- `ALLOWED_OWNERS`: the GitHub users and organisations whose workflows this instance accepts, comma-separated. Anyone else gets 403. This is the only gate (A24).
- `DISCORD_WEBHOOK_URL`: filled in at step 2.
- `NUDGE_AUDIENCE` stays commented out unless the Worker sits behind something that rewrites the request origin; by default the instance accepts tokens whose audience is its own origin, which is what the actions request.

Check that the Worker builds:

    bun test
    bun run deploy:check

## 2. Discord webhook

In Discord, open the private channel's settings → Integrations → Webhooks → New Webhook, name it (for example "Nudge") and copy the webhook URL into `.dev.vars`. Anyone holding this URL can post into the channel, so it lives only there and as a Worker secret.

## 3. Cloudflare token for deploys

Create an API token in the Cloudflare account that will run the Worker: Workers **Editor** on the Worker `nudge` is enough for a `workers.dev` hostname; a custom domain additionally needs **Workers Routes: Edit** on its zone. Prefer an account-owned token (Manage Account → Account API Tokens) over a personal one so it does not depend on a person. Note the account id from the dashboard's Workers overview.

## 4. First deploy, by hand

    bunx wrangler login                              # the account that will run the Worker
    bunx wrangler deploy --env ""                    # prints the workers.dev URL
    bunx wrangler secret bulk --env "" .dev.vars     # loads every value from the file

`--env ""` names the top-level (production) configuration explicitly; the file also defines the throwaway `acceptance` environment of step 7, and wrangler warns when the target is left implicit. Secrets survive every later deploy, so this is done once, and again only when a value changes. (`bunx wrangler deploy --env "" --secrets-file .dev.vars` does both in one step.)

Optional custom domain. The zone must be in the same Cloudflare account; Cloudflare creates the DNS record:

    bunx wrangler deploy --env "" --domain nudge.example.com

The domain stays attached to the Worker from then on: later deploys, including the automatic ones, do not mention it and leave it alone, and `wrangler.toml` never carries it (A23). The dashboard's Domains & Routes page attaches it just the same. The Worker also stays reachable on its `workers.dev` hostname, and each hostname is its own OIDC audience, so every consumer must use the same `endpoint`, or you set `NUDGE_AUDIENCE` to pin one.

Verify that the instance is up and refusing unauthenticated calls:

    curl -si -X POST https://<your hostname>/notify -H 'Content-Type: application/json' -d '{}' | head -1
    # -> HTTP/2 401

Upgrading an instance deployed before 2026-09-27, when `wrangler.toml` still carried `[vars]`: a variable and a secret cannot share a name, so `secret bulk` fails with "Binding name … already in use" until a deploy has removed the variables. Run `bunx wrangler deploy --env "" --secrets-file .dev.vars` once from the updated checkout; it removes them and loads the secrets in the same version.

## 5. Automatic deploys

In the repository settings add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. From then on every push to `main` that touches the Worker runs `.github/workflows/deploy.yml`, which tests, type-checks and deploys. Pull requests run `.github/workflows/ci.yml`. Deploys never touch the secrets or the domain.

## 6. Call it from a repository

In a repository whose owner is in `ALLOWED_OWNERS`, add a job with `id-token: write` that runs the action, pinned by commit hash (why, and how Dependabot keeps it current: `README.md` § Pin by commit hash):

```yaml
jobs:
  notify:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: Taka499/nudge/actions/notify@b706447babea35d3b95dcdbae7ec03f007cb2b2a # v1.0.0
        with:
          endpoint: https://<your hostname>
          title: "Nightly build"
          body: "See the run for details."
```

Run the workflow once by hand (`workflow_dispatch`) and look at the channel. If the step fails it prints the instance's answer, for example `403 repository owner x is not served by this instance` when `ALLOWED_OWNERS` is missing the owner.

## 7. Verify the refusals

A consumer's real run proves the accepted path. The refusals need real GitHub-signed tokens, so they are checked by a workflow in this repository: Actions → Acceptance → Run workflow, with your instance as `endpoint`. It sends a request with no token, a token for another audience, a tampered signature, a junk key id and, unless you switch it off, a token it has waited to expire, and fails unless each is refused with the exact expected answer. Every request carries the body "This message must never appear.", so check the channel afterwards: nothing may have arrived.

To also prove that nothing ties the code to one hostname, deploy a second, throwaway instance from the same commit. It lives only on `workers.dev` and has no secrets at all, so its empty owner list refuses every repository and it can never post:

    bun run deploy:acceptance          # prints https://nudge-acceptance.<account>.workers.dev

Run Acceptance again with that URL as `second_endpoint`. The second instance must refuse a token minted for the first instance (401 `wrong audience`) and must accept a token for its own origin far enough to reach the owner gate (403). Delete it afterwards with `bunx wrangler delete --env acceptance`.

## Milestone 2 (not yet available)

`request` and `resolve` need a Discord application with a bot and an Interactions Endpoint URL, and a GitHub App installed on the consuming repositories; their values go into the same `.dev.vars`. This section is written when that milestone ships. One thing to know in advance: GitHub App names are unique across GitHub, so pick a name for yours other than "Nudge".
