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

console.log(`\n${pass} passed`);
