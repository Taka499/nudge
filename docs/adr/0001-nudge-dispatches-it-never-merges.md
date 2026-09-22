---
status: accepted
---

# Nudge dispatches to the repository; it never merges, deploys or edits anything on GitHub itself

When a person taps Approve in Discord, the service sends a `repository_dispatch` event to the requesting repository, naming the request id and the commit the request was pinned to, and the repository's own committed workflow performs the action — merging a pull request, promoting a branch, or whatever that repository decided. The service therefore needs only the permission to send that event, and a compromised service can do no more than invoke workflows the repository has already committed. Alternatives rejected: the service merging pull requests directly (one credential able to merge into every installed repository, and consumer-specific logic such as ss-assist's merge-then-promote inside the service); a link-only button (no one-tap approval).

Source: user decision A1, grill-me session 2026-09-22 (`docs/plans/EXECPLAN_NUDGE.md` § Decision Log). Asserted from the security reasoning above; not yet exercised.
