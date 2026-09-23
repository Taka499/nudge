# Setting up a Nudge instance

Nudge is self-hosted: one Cloudflare Worker per person or team, serving that owner's repositories (plan decision A12 in `docs/plans/EXECPLAN_NUDGE.md`). This guide takes an operator from a clone to a working `notify` in about half an hour. Nothing in the code names a hostname, owner or channel; everything instance-specific is in `wrangler.toml` and in secrets (A13).

You need: a Cloudflare account (the free plan is enough), a Discord server where you can manage webhooks, and a GitHub account or organisation whose repositories will call the instance.

## 1. Clone and configure

Fork or clone `Taka499/nudge`. Edit `wrangler.toml`:

- `routes`: either set your own custom domain (the zone must be in the same Cloudflare account; Cloudflare creates the DNS record on deploy) or delete the `routes` block to use the free `<name>.<account>.workers.dev` hostname.
- `ALLOWED_OWNERS`: the GitHub users and organisations whose workflows this instance accepts, comma-separated. Anyone else gets 403. Milestone 2 replaces this with the GitHub App installation check.
- `NUDGE_AUDIENCE` stays commented out unless the Worker sits behind something that rewrites the request origin; by default the instance accepts tokens whose audience is its own origin, which is what the actions request.

Install and check that the Worker builds:

    bun install
    bun test
    bun run deploy:check

## 2. Discord webhook

In Discord, open the private channel's settings → Integrations → Webhooks → New Webhook, name it (for example "Nudge") and copy the webhook URL. Anyone holding this URL can post into the channel, so it lives only as a Worker secret.

## 3. Cloudflare token for deploys

Create an API token in the Cloudflare account that will run the Worker. For an account with `tia.run`-style custom domains the token needs Workers **Editor** on the Worker `nudge` and **Workers Routes: Edit** on the zone; for a `workers.dev` hostname the Workers Editor role alone is enough. Prefer an account-owned token (Manage Account → Account API Tokens) over a personal one so it does not depend on a person. Note the account id from the dashboard's Workers overview.

## 4. First deploy, by hand

    bunx wrangler login                              # the account that will run the Worker
    bunx wrangler deploy
    bunx wrangler secret put DISCORD_WEBHOOK_URL     # paste the webhook URL

Verify that the instance is up and refusing unauthenticated calls:

    curl -si -X POST https://<your hostname>/notify -H 'Content-Type: application/json' -d '{}' | head -1
    # -> HTTP/2 401

## 5. Automatic deploys

In the repository settings add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. From then on every push to `main` that touches the Worker runs `.github/workflows/deploy.yml`, which tests, type-checks and deploys. Pull requests run `.github/workflows/ci.yml`.

## 6. Call it from a repository

In a repository whose owner is in `ALLOWED_OWNERS`, give the job `id-token: write` and add the action:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: Taka499/nudge/actions/notify@v1
    with:
      endpoint: https://<your hostname>
      title: "Nightly build: ${{ job.status }}"
      body: "See the run for details."
```

Run the workflow once by hand (`workflow_dispatch`) and look at the channel. If the step fails it prints the instance's answer, for example `403 repository owner x is not served by this instance` when `ALLOWED_OWNERS` is missing the owner.

## 7. Verify the refusals

A consumer's real run proves the accepted path. The refusals need real GitHub-signed tokens, so they are checked by a workflow in this repository: Actions → Acceptance → Run workflow, with your instance as `endpoint`. It sends a request with no token, a token for another audience, a tampered signature, a junk key id and, unless you switch it off, a token it has waited to expire, and fails unless each is refused with the exact expected answer. Every request carries the body "This message must never appear.", so check the channel afterwards: nothing may have arrived.

To also prove that nothing ties the code to one hostname, deploy a second, throwaway instance from the same commit. It lives only on `workers.dev`, has no Discord webhook, and allows only the owner `tia-tools`:

    bun run deploy:acceptance          # prints https://nudge-acceptance.<account>.workers.dev

Edit `ALLOWED_OWNERS` under `[env.acceptance.vars]` in `wrangler.toml` first if your own repositories belong to `tia-tools`: it must exclude the owner of the repository the workflow runs in. Run Acceptance again with that URL as `second_endpoint`. The second instance must refuse a token minted for the first instance (401 `wrong audience`) and must accept a token for its own origin far enough to reach the owner gate (403). Delete it afterwards with `bunx wrangler delete --env acceptance`.

## Milestone 2 (not yet available)

`request` and `resolve` need a Discord application with a bot and an Interactions Endpoint URL, a GitHub App installed on the consuming repositories, and a KV namespace. This section is written when that milestone ships. One thing to know in advance: GitHub App names are unique across GitHub, so pick a name for yours other than "Nudge".
