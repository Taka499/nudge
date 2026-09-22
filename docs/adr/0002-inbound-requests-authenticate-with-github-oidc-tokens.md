---
status: accepted
---

# Inbound requests authenticate with GitHub Actions OIDC tokens, never with per-repository shared secrets

A workflow that wants to notify or ask for approval requests a short-lived OpenID Connect token from GitHub with the audience `nudge.tia.run` and sends it as a bearer token. The service verifies it against GitHub's published keys and takes the repository, run and commit from its claims, so a request can only originate from a real workflow run of that repository, and no consuming repository stores or rotates any secret for the service. Alternative rejected: an HMAC key per repository (one more secret to create and rotate per consumer, and a leaked key lets anyone post as that repository).

Source: user decision A3, grill-me session 2026-09-22 (`docs/plans/EXECPLAN_NUDGE.md` § Decision Log). Verification against GitHub's JWKS is standard practice and documented; not yet implemented here.
