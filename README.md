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
- `CX_FOOTER_HINT=0` — hide the dim placeholder shown when a session has no artifacts
  (`loading…` while the event log is still being read, then `no artifacts yet`)
- `CX_FOOTER_WIDTH=<n>` — pin the column budget (overrides auto-detect); `0` disables
  truncation entirely
- `CX_FOOTER_LINKS=0` — turn the PR/issue/gist labels into plain text (clickable
  OSC-8 hyperlinks are on by default — see below)

## Clickable links & trimming

The labels are **clickable OSC-8 hyperlinks** by default. The catch: the Copilot CLI
renders them fine in the live status-line region, but when a footer row scrolls up
into the terminal scrollback the host re-clamps it to the terminal width *counting
the hyperlink escape bytes* (the URL is in there). A line that is only ~70 visible
columns can be ~240 “columns” of bytes — so a naive footer gets cut **mid-hyperlink**
(`~pullsd#1503` → `~p`) with a dangling escape that corrupts the rows around it.

To stay safe the footer is fitted using that same byte-counting model, so it never
exceeds the host’s budget and is never cut mid-link. When everything doesn’t fit, the
least useful items are rolled up into a single dim `+N` counter — **closed/merged PRs
go first** (as a group), keeping the active and just-created ones in view:

```
⎇ +pullsd#1547 draft ci✓ rev? +2     ← active PR shown, 2 closed PRs rolled up
```

If even one hyperlink is too wide for the terminal, the footer automatically falls
back to plain-text labels for that render so the labels stay visible. Set
`CX_FOOTER_LINKS=0` (or `{"links": false}` in config.json) to always use plain text.

## Fitting the terminal width

The footer keeps itself within the terminal width so it never gets chopped
mid-label. The status-line payload carries no width, so the width is auto-detected
from the controlling TTY. If auto-detect ever misses (or you want a fixed budget),
set `CX_FOOTER_WIDTH` or a `width` number in
`~/.copilot/copilot-pr-footer/config.json`.

## How it works

Copilot CLI's custom status line runs a command every few seconds and passes a
JSON payload on stdin that includes `session_id` and `transcript_path`. This tool:

1. Reads `<transcript_path>/events.jsonl` and detects artifact mutations from three
   kinds of events:
   - **Shell `gh` commands** — joins each tool's `execution_start` (the command) with
     its `execution_complete` (the output) by tool-call id.
   - **MCP-server / extension tools** — `external_tool.requested` calls (e.g. the
     [GitHub MCP server](https://github.com/github/github-mcp-server)). These are
     classified by tool name and resolved from the call's structured arguments
     (`{owner/repo, number}`) or an explicit url field.
   - **Remote shell-exec tools** — tools that run a command elsewhere (e.g. in a
     codespace) are treated like a local `gh` command.
   - **`git push`** — pushing a branch that already has a PR has no PR URL in the
    command, so the PR is surfaced by resolving the pushed branch to its PR via
    `gh pr view` (cached). This appears as an **updated** PR. Disable with
    `{ "detectPush": false }` in config.json.
2. Counts a URL only when it was a real **create** (`gh pr/issue/gist create`, or a
   `create_*` tool → created) or a **mutation** (`gh pr/issue …` edit/comment/review/
   merge/ready/close/…, or an `update_*`/`merge_*`/`add_*_comment` tool → updated).
   Read-only tools (`get_*`, `list_*`, `wait_*`, …) and heredoc bodies that merely
   mention `gh pr create` are ignored, so neither causes a false positive.
3. Resolves live PR state for **all** PRs in a single batched `gh api graphql` call
   (state, draft, review decision, and CI rollup), cached at
   `~/.copilot/copilot-pr-footer/pr-cache.json` and refreshed by a **detached**
   background process so the footer stays instant.

The official GitHub MCP server tools are recognized out of the box. Any unknown tool
is still classified by a generic verb in its name, so most tools work with no setup.

Works for every session that has an event log (present since the first Copilot CLI
sessions). Nothing is sent anywhere; all reads are local and read-only.

### Registering your own tools

If you use a private MCP server or Copilot CLI extension whose tool names this tool
doesn't recognize, register them in `~/.copilot/copilot-pr-footer/config.json` under
`externalTools` — a map of tool name to `created`, `updated`, or `ignore` (to silence
a noisy default). This stays on your machine; nothing is baked into the package.

```json
{
  "externalTools": {
    "my_pr_body_updater": "updated",
    "my_thing_creator": "created",
    "some_noisy_tool": "ignore"
  }
}
```

The tool must pass `{owner/repo, number}` (or a gist id, or a url field) in its
arguments — or the artifact url in its result — for the link to resolve.

Unknown tools are classified by a generic verb in their name (the **heuristic**),
which is on by default. To rely solely on the built-in GitHub MCP defaults plus the
tools you register above, turn it off:

```json
{ "heuristic": false }
```

## Uninstall

```sh
copilot-pr-footer uninstall
npm uninstall -g copilot-pr-footer
```

## Releasing (maintainers)

Releases follow the npm convention of **semver tags `vX.Y.Z`**. Pushing such a tag
triggers the `publish` workflow, which lints, tests, verifies the tag matches
`package.json`, and runs `npm publish`.

```sh
npm version patch     # or minor / major — bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```

Publishing uses npm [**Trusted Publishing**](https://docs.npmjs.com/trusted-publishers/)
(OIDC) — **no `NPM_TOKEN` secret**. Short-lived credentials are minted per run from the
workflow's OIDC identity (`id-token: write`), and provenance is generated automatically.

One-time setup on [npmjs.com](https://www.npmjs.com): *Package → Settings → Trusted
Publisher → GitHub Actions*, then enter:

| Field | Value |
| --- | --- |
| Organization or user | `kamil-gwozdz` |
| Repository | `copilot-pr-footer` |
| Workflow filename | `publish.yml` |

Fields are case-sensitive and must match exactly (including the `.yml` extension).

## Development

```sh
npm install
npm run lint
npm test
```

## License

MIT
