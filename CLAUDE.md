# CLAUDE.md

This file provides guidance to a coding agent when working with code in this repository.

## Central Configuration

This template carries only the project-scoped scaffold: this CLAUDE.md skeleton, `docs/PLANS.md` (ExecPlan methodology), and `docs/adr/README.md` (ADR convention). Cross-project rules and the generic workflow skills (`grill-me`, `close-out`, `codebase-design`, `adopt-from-sibling`, `harvest-session`, `backlog`) live in the central `Taka499/claude` repository, deployed user-level at `~/.claude` — do not copy them into projects.

`docs/PLANS.md` is the one document that exists in both places. The canonical copy is `docs/PLANS.md` in `Taka499/claude`; the copy here is downstream and is checked in so a plan stays followable from a fresh clone with no `~/.claude`. Change the canonical one and propagate; see the note at the top of the file.

## Documentation

Project documentation lives in `docs/`. When creating or updating plans, ExecPlans, or design docs, save them there. Reference existing docs in `docs/` for context on project phases and milestones.

Every document should be self-sufficient: the reader should never need to hunt for context. Explain concepts inline. When a concept is already defined in another checked-in document, you may reference it by file path and section rather than repeating it — but the reference must be precise enough that the reader can find it immediately (e.g., "see `docs/PLANS.md` § Milestones"), not vague ("see the architecture doc").

## ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in `docs/PLANS.md`) from design to implementation. ExecPlans are the persistence layer for cross-session development — they carry forward all context, decisions, and progress so that a fresh session can continue the work without loss. Completed plans are immutable history; when one finishes, run the close-out ritual (`close-out` skill) to extract its durable decisions before moving on.

## Durable Decisions (ADRs)

Cross-plan decisions live in `docs/adr/` (convention: `docs/adr/README.md`). This list is an index, not a home — one line per active decision with a pointer to its ADR; full context, provenance, and lifecycle live in the ADR file. Every non-obvious claim elsewhere in this file must cite its source (`per docs/adr/NNNN` or `per docs/plans/<plan>.md`) so this snapshot stays auditable and rebuildable. When an ADR corrects something an old plan asserted, the ADR wins.

- `docs/adr/0001-nudge-dispatches-it-never-merges.md` — **accepted**: on Approve, Nudge sends a `repository_dispatch` to the repository and the repository's own workflow acts; Nudge never merges, deploys or edits anything on GitHub.
- `docs/adr/0002-inbound-requests-authenticate-with-github-oidc-tokens.md` — **accepted**, amended 2026-09-23: workflows authenticate with a GitHub Actions OIDC token whose audience is the instance's own origin (`nudge.tia.run` for the author's instance); no consumer stores a secret for Nudge.

## Project Overview

Nudge is a Cloudflare Worker at `https://nudge.tia.run` that lets the user's GitHub Actions workflows post to one private Discord channel: plain notifications (`notify`), and questions with Approve and Decline buttons (`request`) whose outcome the repository reports back (`resolve`). A tap on Approve sends a `repository_dispatch` to the repository; the repository's own committed workflow performs the action, so Nudge never merges anything itself (per `docs/adr/0001`), and consumers authenticate with GitHub OIDC tokens rather than stored secrets (per `docs/adr/0002`). It serves the unattended automations in `tia-tools/gakumas-supportcards` (weekly data updates, held cards) and `Taka499/ss-assist` (new character pull requests, approved with the icon shown in Discord), and ships a reusable workflow that warns a month before a Cloudflare deploy token expires. Nudge is a self-hosted template: the repository ships the Worker, composite actions consumers call by tag, and a setup guide, and no tenant value is a constant in the code (per `docs/plans/EXECPLAN_NUDGE.md` decisions A12–A14). Design, milestones and every decision: `docs/plans/EXECPLAN_NUDGE.md`. The repository lives under `Taka499`; the Worker runs on the tia-tools Cloudflare account (same plan, decision A8).

## Architecture

<!-- Describe the high-level structure: key directories, how components relate, data flow. Name the main entry points. -->

## Setup and Development

<!-- How to install dependencies, configure the environment, and run the project locally. Include exact commands. -->

## Build and Test

<!-- List the commands to build, test, lint, and format. Show expected output for a clean run. -->

## Code Style

<!-- Language-specific conventions, naming patterns, import ordering, or formatting tools in use. -->

## Commit Discipline

- Follow Git-flow workflow to manage the branches
- Use small, frequent commits rather than large, infrequent ones
- Only add and commit affected files; leave untracked files as they are
- Never add coding agent attribution in commits

