"use strict";
// Minimal, dependency-free test harness. Run with: npm test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sessionArtifacts } = require("../lib/artifacts");

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log("  \u2713 " + name);
  pass++;
}

function ev(obj) { return JSON.stringify(obj); }

function writeSession(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxpf-"));
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.join("\n"));
  return dir;
}

function start(id, command) {
  return ev({ type: "tool.execution_start", data: { toolCallId: id, toolName: "bash", arguments: { command } } });
}
function complete(id, result) {
  return ev({ type: "tool.execution_complete", data: { toolCallId: id, result } });
}

console.log("sessionArtifacts:");

// 1) created PR
let dir = writeSession([
  start("a", "cd /x && gh pr create --fill"),
  complete("a", "https://github.com/acme/widgets/pull/12\n"),
]);
let arts = sessionArtifacts(dir);
ok("detects a created PR", arts.length === 1 && arts[0].origin === "created" && arts[0].kind === "pr"
   && arts[0].url === "https://github.com/acme/widgets/pull/12");

// 2) updated-only PR
dir = writeSession([
  start("b", "gh pr edit 34 --repo acme/widgets --add-label x"),
  complete("b", "https://github.com/acme/widgets/pull/34\n"),
]);
arts = sessionArtifacts(dir);
ok("detects an updated-only PR", arts.length === 1 && arts[0].origin === "updated"
   && arts[0].url === "https://github.com/acme/widgets/pull/34");

// 3) created wins when both create and update touch the same PR
dir = writeSession([
  start("c", "gh pr create --fill"),
  complete("c", "https://github.com/acme/widgets/pull/56"),
  start("d", "gh pr edit https://github.com/acme/widgets/pull/56 --body x"),
  complete("d", "https://github.com/acme/widgets/pull/56"),
]);
arts = sessionArtifacts(dir);
ok("created wins over update for the same PR",
   arts.length === 1 && arts[0].origin === "created");

// 4) heredoc body mentioning 'gh pr create' must NOT false-fire
dir = writeSession([
  start("e", "cat > /tmp/body.md <<'EOF'\nrun: gh pr create\nsee https://github.com/acme/widgets/pull/99\nEOF"),
  complete("e", ""),
]);
arts = sessionArtifacts(dir);
ok("ignores 'gh pr create' inside a heredoc body", arts.length === 0);

// 5) a merely-referenced URL (no create/update command) is ignored
dir = writeSession([
  start("f", "echo see https://github.com/acme/widgets/pull/77"),
  complete("f", "see https://github.com/acme/widgets/pull/77"),
]);
arts = sessionArtifacts(dir);
ok("ignores referenced/pasted URLs", arts.length === 0);

// 6) --repo + number fallback when no URL is printed
dir = writeSession([
  start("g", "gh pr merge 88 --repo acme/widgets --squash"),
  complete("g", "Merged."),
]);
arts = sessionArtifacts(dir);
ok("constructs URL from --repo + number", arts.length === 1
   && arts[0].url === "https://github.com/acme/widgets/pull/88" && arts[0].origin === "updated");

// 7) missing / empty transcript paths are safe
ok("empty transcript path -> []", sessionArtifacts("").length === 0);
ok("missing dir -> []", sessionArtifacts("/no/such/dir").length === 0);

// 8) created gist on github.com
dir = writeSession([
  start("h", "GH_HOST=github.com gh gist create notes.md"),
  complete("h", "https://gist.github.com/kamil/0426cb4d88b5bf1157df648c46a094d0\n"),
]);
arts = sessionArtifacts(dir);
ok("detects a created gist (github.com)",
   arts.length === 1 && arts[0].kind === "gist" && arts[0].origin === "created");

// 9) created gist on GHES (gist.ghe.io)
dir = writeSession([
  start("i", "GH_HOST=ghe.io gh gist create notes.md"),
  complete("i", "https://gist.ghe.io/kamil-gwozdz/128d909c20fcb90e66e69c12370ce0bf\n"),
]);
arts = sessionArtifacts(dir);
ok("detects a created gist (GHES gist.ghe.io)", arts.length === 1 && arts[0].kind === "gist"
   && arts[0].url === "https://gist.ghe.io/kamil-gwozdz/128d909c20fcb90e66e69c12370ce0bf");

// 10) `gh gist list` output (a read) must NOT be detected
dir = writeSession([
  start("j", "GH_HOST=ghe.io gh gist list"),
  complete("j", "https://gist.ghe.io/kamil/2c4ba8541437b937f038e19d9badd688  notes\n"),
]);
arts = sessionArtifacts(dir);
ok("ignores `gh gist list` output", arts.length === 0);

// --- external (MCP server / extension) tool calls ---------------------------
function ext(toolName, args) {
  return ev({ type: "external_tool.requested", data: { requestId: "r-" + toolName, toolCallId: "t-" + toolName, toolName, arguments: args } });
}
function extDone(toolName, data) {
  return ev({ type: "external_tool.completed", data: Object.assign({ requestId: "r-" + toolName }, data) });
}

// 11) a generic "update_*" extension tool (e.g. a private PR-body updater) with
//     {repo, pr_number} -> updated, with no tool name hard-coded anywhere.
dir = writeSession([ext("update_pr_body", { repo: "github/authzd", pr_number: 6860, ai_title: "x", ai_description: "see https://github.com/other/repo/pull/1" })]);
arts = sessionArtifacts(dir);
ok("detects a generic update_* extension tool as updated", arts.length === 1
   && arts[0].kind === "pr" && arts[0].origin === "updated"
   && arts[0].url === "https://github.com/github/authzd/pull/6860");

// 12) free-text body URL must NOT be picked over the structured {repo, number}
ok("ignores unrelated URL inside a description body",
   arts.length === 1 && arts[0].url === "https://github.com/github/authzd/pull/6860");

// 13) GitHub MCP server default: update_issue {owner, repo, issue_number} -> updated
dir = writeSession([ext("update_issue", { owner: "acme", repo: "widgets", issue_number: 42 })]);
arts = sessionArtifacts(dir);
ok("GitHub MCP update_issue -> updated issue", arts.length === 1 && arts[0].kind === "issue"
   && arts[0].origin === "updated" && arts[0].url === "https://github.com/acme/widgets/issues/42");

// 14) GitHub MCP server default: merge_pull_request {owner, repo, pullNumber} -> updated
dir = writeSession([ext("merge_pull_request", { owner: "acme", repo: "widgets", pullNumber: 7 })]);
arts = sessionArtifacts(dir);
ok("GitHub MCP merge_pull_request -> updated pr", arts.length === 1 && arts[0].kind === "pr"
   && arts[0].origin === "updated" && arts[0].url === "https://github.com/acme/widgets/pull/7");

// 15) read-only external tools must be ignored (verb heuristic + name)
dir = writeSession([
  ext("get_pull_request", { owner: "acme", repo: "widgets", pullNumber: 7 }),
  ext("wait_for_ci", { repo: "acme/widgets", pr_number: 7 }),
  ext("list_issues", { owner: "acme", repo: "widgets" }),
]);
arts = sessionArtifacts(dir);
ok("ignores read-only external tools (get/wait/list)", arts.length === 0);

// 16) a create whose url is only in the result (external_tool.completed)
dir = writeSession([
  ext("create_pull_request", { owner: "acme", repo: "widgets", title: "x", head: "f", base: "main" }),
  extDone("create_pull_request", { result: { html_url: "https://github.com/acme/widgets/pull/100" } }),
]);
arts = sessionArtifacts(dir);
ok("resolves a created PR url from the tool result", arts.length === 1 && arts[0].kind === "pr"
   && arts[0].origin === "created" && arts[0].url === "https://github.com/acme/widgets/pull/100");

// 17) user config can register a private tool name (origin override)
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxpf-cfg-"));
const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
process.env.HOME = cfgDir; process.env.USERPROFILE = cfgDir;
delete require.cache[require.resolve("../lib/artifacts")];
const fresh = require("../lib/artifacts");
fs.mkdirSync(path.join(cfgDir, ".copilot", "copilot-pr-footer"), { recursive: true });
fs.writeFileSync(path.join(cfgDir, ".copilot", "copilot-pr-footer", "config.json"),
  JSON.stringify({ externalTools: { my_secret_pr_tool: "updated" } }));
dir = writeSession([ev({ type: "external_tool.requested", data: { requestId: "z", toolCallId: "z", toolName: "my_secret_pr_tool", arguments: { repo: "acme/widgets", pr_number: 5 } } })]);
arts = fresh.sessionArtifacts(dir);
ok("user-configured external tool is detected", arts.length === 1 && arts[0].kind === "pr"
   && arts[0].origin === "updated" && arts[0].url === "https://github.com/acme/widgets/pull/5");
process.env.HOME = prevHome; if (prevUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUP;

// PR state badges (incl. closed)
console.log("badge:");
const { badge } = require("../bin/cli.js");
const strip = (s) => s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
ok("merged -> merged", strip(badge({ state: "MERGED" })) === "merged");
ok("closed -> closed", strip(badge({ state: "CLOSED" })) === "closed");
ok("closed wins over ci/draft", strip(badge({ state: "CLOSED", isDraft: true, ci: "failed" })) === "closed");
ok("open draft -> draft", strip(badge({ state: "OPEN", isDraft: true })) === "draft");
ok("open ci passed + approved", strip(badge({ state: "OPEN", ci: "passed", review: "APPROVED" })) === "ci\u2713 appr");
ok("open ci running + review required", strip(badge({ state: "OPEN", ci: "running", review: "REVIEW_REQUIRED" })) === "ci\u2026 rev?");
ok("error -> no badge", badge({ error: "x" }) === "");

console.log(`\n${pass} passed`);
