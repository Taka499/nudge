# Setting up a Nudge instance

Nudge is self-hosted: one Cloudflare Worker per person or team, serving that owner's repositories (plan decision A12 in `docs/plans/EXECPLAN_NUDGE.md`). This guide takes an operator from a clone to a working `notify` in about half an hour (steps 1 to 7), and to approvals from Discord with one more step (8). Nothing tracked in the repository names your instance: the code names no hostname, owner or channel (A13), and `wrangler.toml` holds no value of yours either. Every instance value is a Worker secret that you load from one local, gitignored file (`docs/adr/0004`), so a fork never edits a tracked file and pulls upstream cleanly.

You need: a Cloudflare account (the free plan is enough, and no domain: every Worker gets a free `<name>.<account>.workers.dev` hostname), a Discord server you administer (the bot has to be added to it), and a GitHub account or organisation whose repositories will call the instance.

## 1. Clone and fill in the instance file

Fork or clone `Taka499/nudge`, then:

    bun install
    cp .dev.vars.example .dev.vars

Edit `.dev.vars` (gitignored; keep it, it is the readable copy of your instance):

- `ALLOWED_OWNERS`: the GitHub users and organisations whose workflows this instance accepts, comma-separated. Anyone else gets 403. This is the only gate (A24).
- `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID`: filled in at step 2.
- `NUDGE_AUDIENCE` stays commented out unless the Worker sits behind something that rewrites the request origin; by default the instance accepts tokens whose audience is its own origin, which is what the actions request.

Check that the Worker builds:

    bun test
    bun run deploy:check

## 2. Discord application and bot

Every message is posted by a bot that belongs to a Discord application of yours (plan decision A25), the same application that receives button taps from Milestone 2 on. In the [developer portal](https://discord.com/developers/applications): New Application, name it (for example "Nudge"). On the Bot page: Reset Token, and copy the token into `.dev.vars` as `DISCORD_BOT_TOKEN`; it is shown once. On OAuth2 → URL Generator: scope `bot`, permissions View Channels, Send Messages and Embed Links; open the generated URL and add the bot to your server. In Discord, add the bot to the private channel (channel settings → Permissions) and check that View Channel, Send Messages and Embed Links are still allowed for it there, since a channel or category override can take away what the server-level invite granted; then turn on Developer Mode (User Settings → Advanced), right-click the channel → Copy Channel ID, and put it in `.dev.vars` as `DISCORD_CHANNEL_ID`. Anyone holding the bot token can post as the bot, so it lives only in `.dev.vars` and as a Worker secret.

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

Upgrading an instance deployed before 2026-09-27, when `wrangler.toml` still carried `[vars]`: a variable and a secret cannot share a name, so `secret bulk` fails with "Binding name … already in use" until a deploy has removed the variables. Run `bunx wrangler deploy --env "" --secrets-file .dev.vars` once from the updated checkout; it removes them and loads the secrets in the same version. An instance from before Milestone 2 posted through a channel webhook; after adding the two Discord values above, the retired secret can go: `bunx wrangler secret delete --env "" DISCORD_WEBHOOK_URL`.

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

## 8. Approvals: the endpoint, the allowlist and the GitHub App

`request` and `resolve` need three more things from the application of step 2, one GitHub App, and a deploy in between.

**From the Discord application.** On General Information copy the Public Key into `.dev.vars` as `DISCORD_PUBLIC_KEY`; it lets the instance check that every button press really comes from Discord. Put the Discord user ids allowed to tap Approve or Decline in `DISCORD_ALLOWED_USERS`, comma-separated (Developer Mode → right-click a user → Copy User ID); anyone else's tap gets a private "not on the list" reply and changes nothing.

**A GitHub App.** GitHub → Settings → Developer settings → GitHub Apps → New GitHub App. App names are unique across GitHub, so pick your own, not "Nudge". Homepage: anything. Untick "Active" under Webhook. Repository permissions: Contents, Read and write, nothing else; it is what `repository_dispatch` needs. "Where can this GitHub App be installed?": "Only on this account" if every repository that raises requests belongs to the account creating the App, otherwise "Any account" (a stranger installing it gains nothing: their repositories still fail the owner list, A24). Create it, note the App ID into `.dev.vars` as `GITHUB_APP_ID`, generate a private key, and install the App on every repository that will raise requests. The key GitHub downloads is multi-line, so it goes in on its own:

    bunx wrangler secret bulk --env "" .dev.vars
    bunx wrangler secret put --env "" GITHUB_APP_PRIVATE_KEY < <downloaded>.private-key.pem

**The endpoint.** Once the Worker is deployed with those values, back in the Discord application's General Information set Interactions Endpoint URL to `https://<your hostname>/interactions` and save. Discord sends a signed PING at that moment and refuses to save unless the instance answers it. From then on a tap reaches the Worker. Discord also removes an endpoint that accepts a bad signature, which this one never does.

**Then, in each repository**, the `request` step and the dispatch handler from `README.md` § Ask for an approval. The first real request proves the path end to end: tap Approve, watch the handler run, and see the message change to "done".
