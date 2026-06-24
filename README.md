# copilot-pr-footer

[![ci](https://github.com/kamil-gwozdz/copilot-pr-footer/actions/workflows/ci.yml/badge.svg)](https://github.com/kamil-gwozdz/copilot-pr-footer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/copilot-pr-footer.svg)](https://www.npmjs.com/package/copilot-pr-footer)
[![license: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Show the pull requests, issues, and gists your **GitHub Copilot CLI** session
**created** or **updated** — with live **CI / review / merge** state — right in
Copilot's status-line footer.

Examples:

1. Screenshoot
<img width="673" height="461" alt="Screenshot 2026-06-24 at 15 59 16" src="https://github.com/user-attachments/assets/7e5c30ed-ddc3-4475-9d05-75c63045bdae" />


2. More complex example
```
⎇ +reposd#2488 merged  +rails#1340 ci✓ appr  ~ruby#50669 ci…
```

- `+` (green) = the session **created** it · `~` (blue) = the session **updated** it
- State badges: `draft` · `ci…` running · `ci✓` passed · `ci✗` failed · `rev?` review
  required · `appr` approved · `chg` changes requested · `merged` · `closed`
- Links are clickable (OSC 8)

It reads the session's own event log to tell **what the agent actually did** from
URLs you merely pasted or referenced, and never blocks the footer on the network
(PR state is cached and refreshed in the background).

## Install

```sh
npm install -g copilot-pr-footer
copilot-pr-footer install
```

Then open a new Copilot CLI session. That's it.

`install` sets `statusLine` and `footer.showCustom` in `~/.copilot/settings.json`.

## Requirements

- **Node.js ≥ 16**
- **[GitHub CLI](https://cli.github.com) (`gh`)**, authenticated (`gh auth login`),
  for the PR-state badges. Without it, the footer still lists created/updated
  artifacts and shows a one-line hint (suppressible — see below).

## Commands

| Command | What it does |
|---|---|
| `copilot-pr-footer install` | Wire it into `~/.copilot/settings.json` |
| `copilot-pr-footer uninstall` | Remove it from `settings.json` |
| `copilot-pr-footer doctor` | Show status (node, gh, settings) |
| `copilot-pr-footer disable-gh-warning` | Hide the “gh not installed/authorized” line |
| `copilot-pr-footer enable-gh-warning` | Show it again |

## Configuration (env vars)

- `CX_FOOTER_STATE=0` — disable live PR-state badges (just list artifacts)
- `CX_FOOTER_HINT=0` — hide the dim “no artifacts yet” placeholder

## How it works

Copilot CLI's custom status line runs a command every few seconds and passes a
JSON payload on stdin that includes `session_id` and `transcript_path`. This tool:

1. Reads `<transcript_path>/events.jsonl` and joins each tool's
   `execution_start` (the command) with its `execution_complete` (the output) by
   tool-call id.
2. Counts a URL only when its command was a real `gh pr/issue/gist create`
   (→ created) or a mutating `gh pr/issue …` (edit, comment, review, merge, ready,
   close, …) (→ updated). Heredoc bodies are stripped so a PR body that mentions
   `gh pr create` can't cause a false positive.
3. Resolves live PR state via `gh pr view --json …`, cached at
   `~/.copilot/copilot-pr-footer/pr-cache.json` and refreshed by a **detached**
   background process so the footer stays instant.

Works for every session that has an event log (present since the first Copilot CLI
sessions). Nothing is sent anywhere; all reads are local and read-only.

## Uninstall

```sh
copilot-pr-footer uninstall
npm uninstall -g copilot-pr-footer
```

## Releasing (maintainers)

Releases follow the npm convention of **semver tags `vX.Y.Z`**. Pushing such a tag
triggers the `publish` workflow, which lints, tests, verifies the tag matches
`package.json`, and runs `npm publish --provenance`.

```sh
npm version patch     # or minor / major — bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```

One-time setup: add an **`NPM_TOKEN`** repository secret (an npm
[automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)) under
*Settings → Secrets and variables → Actions*. Provenance needs no extra secret — it
uses the workflow's OIDC identity (`id-token: write`).

## Development

```sh
npm install
npm run lint
npm test
```

## License

MIT
