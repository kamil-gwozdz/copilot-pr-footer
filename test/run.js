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

// 7b) eventsReady distinguishes "still loading" from "ready" (drives the loading hint)
const { eventsReady } = require("../lib/artifacts");
ok("eventsReady false for empty/missing path", eventsReady("") === false && eventsReady("/no/such/dir") === false);
ok("eventsReady false when events.jsonl is missing", (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cxpf-er-"));
  return eventsReady(d) === false;
})());
ok("eventsReady false when events.jsonl is empty (still being written)", (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cxpf-er-"));
  fs.writeFileSync(path.join(d, "events.jsonl"), "");
  return eventsReady(d) === false;
})());
ok("eventsReady true once events.jsonl has content", (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cxpf-er-"));
  fs.writeFileSync(path.join(d, "events.jsonl"), start("a", "echo hi"));
  return eventsReady(d) === true;
})());

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

// 18) config heuristic:false disables the verb fallback but keeps known defaults
const cfgDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cxpf-cfg2-"));
process.env.HOME = cfgDir2; process.env.USERPROFILE = cfgDir2;
delete require.cache[require.resolve("../lib/artifacts")];
const fresh2 = require("../lib/artifacts");
fs.mkdirSync(path.join(cfgDir2, ".copilot", "copilot-pr-footer"), { recursive: true });
fs.writeFileSync(path.join(cfgDir2, ".copilot", "copilot-pr-footer", "config.json"),
  JSON.stringify({ heuristic: false }));
dir = writeSession([
  ev({ type: "external_tool.requested", data: { requestId: "h1", toolCallId: "h1", toolName: "edit_something_unknown", arguments: { repo: "acme/widgets", pr_number: 5 } } }),
  ev({ type: "external_tool.requested", data: { requestId: "h2", toolCallId: "h2", toolName: "update_issue", arguments: { owner: "acme", repo: "widgets", issue_number: 9 } } }),
]);
arts = fresh2.sessionArtifacts(dir);
ok("heuristic:false ignores unknown tools but keeps GitHub MCP defaults",
   arts.length === 1 && arts[0].kind === "issue" && arts[0].url === "https://github.com/acme/widgets/issues/9");
process.env.HOME = prevHome; if (prevUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUP;
delete require.cache[require.resolve("../lib/artifacts")];

// 18) `git push origin <branch>` surfaces a push:// pseudo-PR (resolved later via gh)
dir = writeSession([
  start("p1", "cd ~/Work/graph-hopper && git push origin kamil-gwozdz/foo 2>&1 | tail -8"),
  complete("p1", "Everything up-to-date"),
]);
arts = sessionArtifacts(dir);
ok("git push surfaces a push:// pseudo-PR (updated)", arts.length === 1 && arts[0].kind === "pr"
   && arts[0].origin === "updated" && arts[0].url === "push://~/Work/graph-hopper|kamil-gwozdz/foo");

// 19) push detection can be disabled via config.detectPush=false
const cfgDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "cxpf-cfg3-"));
process.env.HOME = cfgDir3; process.env.USERPROFILE = cfgDir3;
delete require.cache[require.resolve("../lib/artifacts")];
const fresh3 = require("../lib/artifacts");
fs.mkdirSync(path.join(cfgDir3, ".copilot", "copilot-pr-footer"), { recursive: true });
fs.writeFileSync(path.join(cfgDir3, ".copilot", "copilot-pr-footer", "config.json"),
  JSON.stringify({ detectPush: false }));
dir = writeSession([start("p2", "git push origin main"), complete("p2", "")]);
arts = fresh3.sessionArtifacts(dir);
ok("detectPush:false ignores git push", arts.length === 0);
process.env.HOME = prevHome; if (prevUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUP;
delete require.cache[require.resolve("../lib/artifacts")];

// 20) pushTargetsFrom parses dir + branch (and refspec dst / -C / bare push)
const { pushTargetsFrom } = require("../lib/artifacts");
ok("parses cd + explicit branch", (() => {
  const t = pushTargetsFrom("cd /x && git push origin feature/y");
  return t.length === 1 && t[0].dir === "/x" && t[0].branch === "feature/y";
})());
ok("parses src:dst refspec to dst, skips -u flag", (() => {
  const t = pushTargetsFrom("git -C /r push -u origin HEAD:main");
  return t.length === 1 && t[0].dir === "/r" && t[0].branch === "main";
})());
ok("bare `git push` -> empty branch (current)", (() => {
  const t = pushTargetsFrom("git push"); return t.length === 1 && t[0].branch === "";
})());
ok("non-push commands yield nothing", pushTargetsFrom("git status").length === 0);


const { badge } = require("../bin/cli.js");
const strip = (s) => s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
ok("merged -> merged", strip(badge({ state: "MERGED" })) === "merged");
ok("closed -> closed", strip(badge({ state: "CLOSED" })) === "closed");
ok("closed wins over ci/draft", strip(badge({ state: "CLOSED", isDraft: true, ci: "failed" })) === "closed");
ok("open draft -> draft", strip(badge({ state: "OPEN", isDraft: true })) === "draft");
ok("open ci passed + approved", strip(badge({ state: "OPEN", ci: "passed", review: "APPROVED" })) === "ci\u2713 appr");
ok("open ci running + review required", strip(badge({ state: "OPEN", ci: "running", review: "REVIEW_REQUIRED" })) === "ci\u2026 rev?");
ok("error -> no badge", badge({ error: "x" }) === "");

// batched GraphQL rollup -> ci state mapping
console.log("rollupToCi:");
const { rollupToCi, parsePrUrl } = require("../lib/artifacts");
ok("SUCCESS -> passed", rollupToCi("SUCCESS") === "passed");
ok("PENDING -> running", rollupToCi("PENDING") === "running");
ok("EXPECTED -> running", rollupToCi("EXPECTED") === "running");
ok("FAILURE -> failed", rollupToCi("FAILURE") === "failed");
ok("ERROR -> failed", rollupToCi("ERROR") === "failed");
ok("null/none -> none", rollupToCi(null) === "none");
ok("parsePrUrl extracts owner/repo/number",
   (() => { const p = parsePrUrl("https://github.com/acme/widgets/pull/12"); return p && p.owner === "acme" && p.repo === "widgets" && p.number === "12"; })());
ok("parsePrUrl rejects non-github.com hosts", parsePrUrl("https://ghe.io/acme/widgets/pull/12") === null);

// width-aware truncation
console.log("composeLine / visibleWidth:");
const { visibleWidth, composeLine, resolveWidth } = require("../bin/cli.js");
const link = (u, t) => `\x1b]8;;${u}\x1b\\${t}\x1b]8;;\x1b\\`;
const DIMc = "\x1b[2m", RESETc = "\x1b[0m";
const ESCc = String.fromCharCode(27);
const visOf = (s) => s
  .replace(new RegExp(ESCc + "\\]8;;[^" + ESCc + "]*" + ESCc + "\\\\", "g"), "")
  .replace(new RegExp(ESCc + "\\[[0-9;]*m", "g"), "");

ok("visibleWidth ignores SGR colors", visibleWidth(`${DIMc}draft${RESETc}`) === 5);
ok("visibleWidth ignores OSC-8 hyperlink target",
   visibleWidth(link("https://github.com/a/b/pull/123456789", "pr#1")) === 4);

const mk = (s) => ({ s, w: visibleWidth(s) });
const c1 = mk(link("https://github.com/x/y/pull/1", "y#1"));   // w=3
const c2 = mk(link("https://github.com/x/y/pull/22", "y#22")); // w=4
const c3 = mk(link("https://github.com/x/y/pull/333", "y#333")); // w=5
const chips = [c1, c2, c3];

ok("width 0 -> no truncation, all shown",
   visOf(composeLine(chips, 0, 0)) === "y#1  y#22  y#333");
ok("width 0 -> appends hidden +N counter",
   visOf(composeLine(chips, 2, 0)) === "y#1  y#22  y#333 +2");
ok("ample width -> unchanged",
   visOf(composeLine(chips, 0, 100)) === "y#1  y#22  y#333");

const tight = composeLine(chips, 0, 15); // 3+2+4+2+5 = 16 > 15
ok("tight width drops a trailing chip and adds +N",
   /\+\d+$/.test(visOf(tight)) && visOf(tight).indexOf("y#1") === 0);
ok("truncated line never exceeds the budget (minus 1-col margin)",
   visibleWidth(tight) <= 15 - 1);
ok("very narrow width collapses to just the counter",
   visOf(composeLine(chips, 0, 4)) === "+3");

// closed/merged PRs (prio>=2) are rolled up first, keeping the active chip
const pc = (s, prio) => ({ s, w: visibleWidth(s), prio });
const active = pc(link("https://github.com/x/y/pull/1", "y#1"), 0);   // w=3
const closedA = pc(link("https://github.com/x/y/pull/22", "y#22 closed"), 2);  // w=11
const closedB = pc(link("https://github.com/x/y/pull/333", "y#333 closed"), 2); // w=12
ok("closed PRs roll up into +N before the active one is touched", (() => {
  // budget too small for all three, but the active chip easily fits alone
  const out = visOf(composeLine([active, closedA, closedB], 0, 14));
  return out === "y#1 +2";
})());
ok("a closed PR still shows if everything fits",
   visOf(composeLine([active, closedA], 0, 40)) === "y#1  y#22 closed");

ok("resolveWidth honors CX_FOOTER_WIDTH override", (() => {
  const prev = process.env.CX_FOOTER_WIDTH;
  process.env.CX_FOOTER_WIDTH = "42";
  const w = resolveWidth({}, {});
  if (prev === undefined) delete process.env.CX_FOOTER_WIDTH; else process.env.CX_FOOTER_WIDTH = prev;
  return w === 42;
})());
ok("resolveWidth honors config.width", (() => {
  const prev = process.env.CX_FOOTER_WIDTH;
  delete process.env.CX_FOOTER_WIDTH;
  const w = resolveWidth({}, { width: 64 });
  if (prev !== undefined) process.env.CX_FOOTER_WIDTH = prev;
  return w === 64;
})());

// hyperlinks are ON by default; we fit using hostWidth (which counts OSC-8 bytes)
// so the host's scrollback clamp can't cut mid-hyperlink.
console.log("links default-on / hostWidth:");
const { hostWidth, linksEnabled } = require("../bin/cli.js");
ok("links default ON", (() => {
  const a = process.env.CX_FOOTER_LINKS; delete process.env.CX_FOOTER_LINKS;
  const r = linksEnabled({}) === true && linksEnabled({ links: false }) === false;
  if (a !== undefined) process.env.CX_FOOTER_LINKS = a;
  return r;
})());
ok("CX_FOOTER_LINKS=0 disables links", (() => {
  const a = process.env.CX_FOOTER_LINKS; process.env.CX_FOOTER_LINKS = "0";
  const r = linksEnabled({}) === false;
  if (a === undefined) delete process.env.CX_FOOTER_LINKS; else process.env.CX_FOOTER_LINKS = a;
  return r;
})());
ok("hostWidth counts OSC-8 bytes (unlike visibleWidth)", (() => {
  const s = link("https://github.com/a/b/pull/123456789", "b#1");
  return visibleWidth(s) === 3 && hostWidth(s) > 30;
})());
ok("hostWidth == visibleWidth for plain SGR-only text",
   hostWidth(`${DIMc}closed${RESETc}`) === visibleWidth(`${DIMc}closed${RESETc}`));

console.log(`\n${pass} passed`);