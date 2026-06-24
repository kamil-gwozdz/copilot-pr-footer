"use strict";
// Core logic: detect the PRs/issues/gists a Copilot CLI session created or updated
// (from its events.jsonl), and resolve live PR state via gh (cached, non-blocking).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const CACHE_DIR = path.join(os.homedir(), ".copilot", "copilot-pr-footer");
const CACHE = path.join(CACHE_DIR, "pr-cache.json");
const LOCK = path.join(CACHE_DIR, ".fetch.lock");
const CONFIG = path.join(CACHE_DIR, "config.json");
const CLI = path.join(__dirname, "..", "bin", "cli.js");
const TTL_MS = 45 * 1000; // a cached PR state is fresh for this long
const SPAWN_GUARD_MS = 25 * 1000; // don't spawn a refresh if one started this recently

// Verbs matched only at a *command position* (segment start, after optional ENV=val
// prefixes), so they never false-fire on heredoc bodies / echo / grep / cat text.
const CREATE_RE =
  /^(?:\w+=\S+\s+)*gh\s+(?:pr|issue)\s+create\b|^(?:\w+=\S+\s+)*gh\s+gist\s+create\b/i;
const UPDATE_RE =
  /^(?:\w+=\S+\s+)*gh\s+pr\s+(?:edit|comment|review|merge|ready|close|reopen|lock|unlock)\b|^(?:\w+=\S+\s+)*gh\s+issue\s+(?:edit|comment|close|reopen|lock|unlock|pin|unpin|transfer)\b|^(?:\w+=\S+\s+)*gh\s+gist\s+(?:edit|rename)\b/i;
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g;
const REPO_FLAG_RE = /--repo[= ]+([\w.-]+\/[\w.-]+)/;
const NUM_ARG_RE = /(?<!\w)(\d{1,7})(?!\w)/g;
// Tools that actually execute shell commands (so their text may legitimately be a
// `gh … create`). Matches bash/shell/sh/zsh/pwsh/terminal/exec/command/codespace.
const EXEC_TOOL = /(?:^|[_-])(?:bash|shell|sh|zsh|pwsh|powershell|terminal|command|exec|codespace)(?:$|[_-])/i;
const CANON = {
  pr: /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g,
  issue: /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g,
  // Any GitHub(.com or GHES) gist host; require a hex id so /api/v3/ and list
  // output don't match. Covers e.g. gist.github.com/<id> and gist.ghe.io/<owner>/<id>.
  gist: /https:\/\/gist\.[\w.-]+\/(?:[\w-]+\/)?[0-9a-f]{8,}/g,
  codespace: /https:\/\/github\.com\/codespaces\/[\w./?=&-]+/g,
};

// Classify an *external* tool call (MCP server tool or Copilot CLI extension tool)
// by a generic verb in its name. No tool name is ever hard-coded, so this works
// uniformly for the GitHub MCP server, third-party extensions, etc. Read-only verbs
// are rejected first so a tool that merely references a PR/issue (e.g. a "view" or
// "wait_for_ci") never counts as a mutation.
const EXT_READONLY = /(?:^|[_-])(?:get|list|search|read|view|find|fetch|show|status|check|wait|diff|count|describe|download|clone|compare)(?:$|[_-])/i;
const EXT_CREATE = /(?:^|[_-])(?:create|new|generate|fork|import|open)(?:$|[_-])/i;
const EXT_UPDATE = /(?:^|[_-])(?:update|edit|patch|modify|merge|close|reopen|comment|review|ready|rename|lock|unlock|pin|unpin|transfer|convert|resolve|assign|label|mark|dismiss|submit|add|request|move|push|enable|disable|set|delete|remove)(?:$|[_-])/i;
// Only these arg fields are trusted to hold an artifact URL — never free-text bodies
// (e.g. a PR description), which may link to unrelated PRs/issues.
const URL_FIELDS = ["url", "html_url", "htmlUrl", "permalink", "link", "pr_url", "issue_url", "gist_url"];

// Built-in classification for well-known *public* external tools (the official
// GitHub MCP server, github/github-mcp-server). These names are public, so baking
// them in leaks nothing. Users register their own/private tools via config.json
// ("externalTools"), which takes precedence over these. "create" wins over "update".
const DEFAULT_EXTERNAL_TOOLS = {
  create_pull_request: "create",
  update_pull_request: "update",
  update_pull_request_branch: "update",
  merge_pull_request: "update",
  request_copilot_review: "update",
  create_pending_pull_request_review: "update",
  create_and_submit_pull_request_review: "update",
  add_comment_to_pending_review: "update",
  submit_pending_pull_request_review: "update",
  create_issue: "create",
  update_issue: "update",
  add_issue_comment: "update",
  add_sub_issue: "update",
  assign_copilot_to_issue: "update",
  create_gist: "create",
  update_gist: "update",
};

function stripHeredocs(cmd) {
  return cmd.replace(HEREDOC_RE, "");
}

// Split a command into pipeline/list segments, respecting single/double quotes so
// that operators inside quoted args (e.g. a grep regex 'gh pr create|gh ... ') do
// NOT create spurious segments.
function splitSegments(s) {
  const out = [];
  let cur = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "&" && s[i + 1] === "&") { out.push(cur); cur = ""; i++; continue; }
    if (c === "|" && s[i + 1] === "|") { out.push(cur); cur = ""; i++; continue; }
    if (c === "|" || c === ";" || c === "\n") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function classifyCommand(command) {
  if (!command) return null;
  const stripped = stripHeredocs(command);
  let origin = null;
  for (const seg of splitSegments(stripped)) {
    const s = seg.trim();
    if (CREATE_RE.test(s)) return "create"; // create dominates
    if (UPDATE_RE.test(s)) origin = "update";
  }
  return origin;
}

function commandOf(args) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const v = args.command;
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(String).join(" ");
    try { return JSON.stringify(args); } catch { return ""; }
  }
  return "";
}

function urlsFrom(blob, command) {
  if (typeof blob !== "string") blob = "";
  const found = [];
  for (const kind of Object.keys(CANON)) {
    const m = blob.match(CANON[kind]);
    if (m) for (const u of m) found.push([kind, u]);
  }
  if (found.length === 0 && command) {
    for (const kind of Object.keys(CANON)) {
      const m = command.match(CANON[kind]);
      if (m) for (const u of m) found.push([kind, u]);
    }
    if (found.length === 0) {
      const repo = REPO_FLAG_RE.exec(command);
      if (repo) {
        const nums = stripHeredocs(command).match(NUM_ARG_RE);
        const kind = /\bgh\s+pr\b/i.test(command)
          ? "pr"
          : /\bgh\s+issue\b/i.test(command)
          ? "issue"
          : null;
        if (kind && nums && nums.length) {
          const seg = kind === "pr" ? "pull" : "issues";
          found.push([kind, `https://github.com/${repo[1]}/${seg}/${nums[0]}`]);
        }
      }
    }
  }
  return found;
}

// --- external (MCP server / extension) tool detection ------------------------

// Normalize a config "externalTools" value into a {name -> "create"|"update"|null}
// map. Accepts an array of names (treated as updates) or an object mapping a name
// to an origin / created|updated / a falsy or "ignore" value (to suppress a default).
function normalizeToolsConfig(raw) {
  const map = {};
  if (!raw) return map;
  const set = (k, v) => {
    const key = String(k).toLowerCase().trim();
    if (!key) return;
    if (v === false || v === null) { map[key] = null; return; }
    const s = String(v).toLowerCase();
    if (s === "created" || s === "create") map[key] = "create";
    else if (["ignore", "none", "skip", "off", "false"].includes(s)) map[key] = null;
    else map[key] = "update"; // "updated"/"update"/anything else -> update
  };
  if (Array.isArray(raw)) for (const n of raw) set(n, "update");
  else if (typeof raw === "object") for (const k of Object.keys(raw)) set(k, raw[k]);
  return map;
}

// Generic verb-based fallback so unknown tools still classify without hard-coding.
function extOrigin(name) {
  if (!name) return null;
  if (EXT_READONLY.test(name)) return null; // a read tool never mutates an artifact
  if (EXT_CREATE.test(name)) return "create";
  if (EXT_UPDATE.test(name)) return "update";
  return null;
}

// Resolve a tool's origin: user config wins, then the built-in GitHub MCP defaults,
// then the universal verb heuristic. A config/default value of null suppresses it.
function toolOrigin(name, toolsMap) {
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  if (toolsMap && Object.prototype.hasOwnProperty.call(toolsMap, n)) return toolsMap[n];
  if (Object.prototype.hasOwnProperty.call(DEFAULT_EXTERNAL_TOOLS, n)) return DEFAULT_EXTERNAL_TOOLS[n];
  return extOrigin(n);
}

function repoOf(a) {
  const slug = (s) => typeof s === "string" && /^[\w.-]+\/[\w.-]+$/.test(s);
  if (slug(a.repo)) return a.repo;
  if (slug(a.repository)) return a.repository;
  if (slug(a.nameWithOwner)) return a.nameWithOwner;
  if (slug(a.full_name)) return a.full_name;
  const owner = [a.owner, a.org, a.organization].find((x) => typeof x === "string");
  let name = null;
  if (typeof a.repo === "string" && !a.repo.includes("/")) name = a.repo;
  else if (typeof a.name === "string" && !a.name.includes("/")) name = a.name;
  if (owner && name) return `${owner}/${name}`;
  return null;
}

function firstNum(a, keys) {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string" && /^\d{1,7}$/.test(v)) return parseInt(v, 10);
  }
  return null;
}

function urlFieldOf(a) {
  for (const k of URL_FIELDS) {
    const v = a[k];
    if (typeof v !== "string") continue;
    for (const kind of Object.keys(CANON)) {
      const m = v.match(CANON[kind]);
      if (m && m.length) return [kind, m[0]];
    }
  }
  return null;
}

// Extract [kind, url] for a mutating external tool from its *arguments* (the only
// data reliably present; external_tool.completed carries no result). URLs are taken
// only from explicit url fields or constructed from {owner/repo, number} — never
// scraped from free-text bodies. Returns null if no artifact can be resolved.
function externalUrl(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const lname = String(name).toLowerCase();
  const uf = urlFieldOf(a);
  if (uf) return uf;
  const repo = repoOf(a);
  if (repo) {
    const pr = firstNum(a, ["pr_number", "pull_number", "pullNumber", "pullRequestNumber", "prNumber"]);
    if (pr != null) return ["pr", `https://github.com/${repo}/pull/${pr}`];
    const iss = firstNum(a, ["issue_number", "issueNumber", "issueNo"]);
    if (iss != null) return ["issue", `https://github.com/${repo}/issues/${iss}`];
    const num = firstNum(a, ["number", "id"]);
    if (num != null) {
      if (/pull|(?:^|[_-])pr(?:$|[_-])/.test(lname)) return ["pr", `https://github.com/${repo}/pull/${num}`];
      if (/issue/.test(lname)) return ["issue", `https://github.com/${repo}/issues/${num}`];
    }
  }
  if (/gist/.test(lname)) {
    const gid = [a.gist_id, a.gistId, a.gist, a.id].find((x) => typeof x === "string" && /^[0-9a-f]{8,}$/i.test(x));
    if (gid) return ["gist", `https://gist.github.com/${gid}`];
  }
  return null;
}
// Return [{kind, url, origin}] for artifacts the session created or updated,
// newest last. origin is "created" or "updated" (created wins if both). Detects
// mutations from three event shapes: shell `gh …` commands (tool.execution_*),
// remote shell-exec tools (external_tool.* whose name looks like a shell), and
// structured MCP-server / extension tool calls (external_tool.requested args).
function sessionArtifacts(transcriptPath) {
  if (!transcriptPath) return [];
  const ev = path.join(transcriptPath, "events.jsonl");
  let data;
  try {
    data = fs.readFileSync(ev, "utf8");
  } catch {
    return [];
  }
  const toolsMap = normalizeToolsConfig(loadConfig().externalTools);
  const flagged = new Map(); // toolCallId -> [origin, command]
  const extPending = new Map(); // requestId -> tag (mutation whose url wasn't in args)
  const originOf = new Map(); // url -> "created" | "updated"
  const kindOf = new Map();
  const order = [];
  const rec = (kind, url, tag) => {
    if (!["pr", "issue", "gist", "codespace"].includes(kind)) return;
    if (!originOf.has(url)) {
      order.push(url);
      kindOf.set(url, kind);
      originOf.set(url, tag);
    } else if (tag === "created") {
      originOf.set(url, "created"); // upgrade update -> created
    }
  };
  for (const line of data.split("\n")) {
    // "tool.execution_start" is a substring of "...started" (and likewise complete),
    // so these cover both naming variants. The external_tool.* names are distinct.
    const isStart = line.indexOf("tool.execution_start") !== -1;
    const isComplete = !isStart && line.indexOf("tool.execution_complete") !== -1;
    const isExtReq = !isStart && !isComplete && line.indexOf("external_tool.requested") !== -1;
    const isExtDone = !isStart && !isComplete && !isExtReq && line.indexOf("external_tool.completed") !== -1;
    if (!isStart && !isComplete && !isExtReq && !isExtDone) continue;

    // External (MCP server / extension) tool call — classify from name + args.
    if (isExtReq) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const d = e && typeof e.data === "object" ? e.data : {};
      const name = String(d.toolName || d.name || "");
      const args = d.arguments || d.args;
      // A remote shell-exec tool (e.g. one that runs a command in a codespace):
      // treat its command exactly like a local `gh …` command.
      if (EXEC_TOOL.test(name) && args && typeof (args.command || args.cmd) === "string") {
        const cmd = commandOf(args);
        const origin = classifyCommand(cmd);
        if (origin) for (const [kind, url] of urlsFrom("", cmd)) rec(kind, url, origin === "create" ? "created" : "updated");
        continue;
      }
      const origin = toolOrigin(name, toolsMap);
      if (!origin) continue;
      const tag = origin === "create" ? "created" : "updated";
      const hit = externalUrl(name, args);
      if (hit) rec(hit[0], hit[1], tag);
      else if (d.requestId) extPending.set(d.requestId, tag); // url may be in the result
      continue;
    }
    // External tool result — only useful to resolve a create whose url wasn't in args.
    if (isExtDone) {
      if (extPending.size === 0) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const d = e && typeof e.data === "object" ? e.data : {};
      const tag = extPending.get(d.requestId);
      if (!tag) continue;
      extPending.delete(d.requestId);
      const blob = (() => { try { return JSON.stringify(d); } catch { return ""; } })();
      const hits = urlsFrom(blob, "");
      if (hits.length) rec(hits[0][0], hits[0][1], tag); // first/primary url only
      continue;
    }

    if (isStart) {
      // cheap keyword gate: a create/update command always names the verb/type
      if (!line.includes("create") && !line.includes(" pr ") &&
          !line.includes("issue") && !line.includes("gist")) continue;
    } else {
      // only parse completes whose start was flagged (id appears in the line)
      let hit = false;
      for (const id of flagged.keys()) {
        if (id && line.indexOf('"' + id + '"') !== -1) { hit = true; break; }
      }
      if (!hit) continue;
    }
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const d = e.data && typeof e.data === "object" ? e.data : {};
    const tcid = d.toolCallId || d.tool_call_id;
    if (isStart) {
      // Only shell/exec tools run commands. File tools (create/edit/view/…) may
      // contain shell-looking text in their args and must NOT be classified.
      const tool = String(d.toolName || "").toLowerCase();
      if (!EXEC_TOOL.test(tool)) continue;
      const cmd = commandOf(d.arguments);
      const origin = classifyCommand(cmd);
      if (origin) flagged.set(tcid, [origin, cmd]);
    } else if (flagged.has(tcid)) {
      const [origin, command] = flagged.get(tcid);
      const res = d.result;
      const blob = typeof res === "string" ? res : (res == null ? "" : JSON.stringify(res) || "");
      for (const [kind, url] of urlsFrom(blob, command)) {
        rec(kind, url, origin === "create" ? "created" : "updated");
      }
    }
  }
  return order.map((u) => ({ kind: kindOf.get(u), url: u, origin: originOf.get(u) }));
}

// --- live PR state -----------------------------------------------------------

function ghBin() {
  for (const p of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return "gh";
}

// Fast, filesystem-only check (no subprocess) so the footer hot path stays cheap.
function ghInstalled() {
  const names = process.platform === "win32" ? ["gh.exe", "gh.cmd", "gh"] : ["gh"];
  for (const p of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try { if (fs.existsSync(p)) return true; } catch {}
  }
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH || "").split(sep)) {
    if (!dir) continue;
    for (const n of names) {
      try { if (fs.existsSync(path.join(dir, n))) return true; } catch {}
    }
  }
  return false;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

// {installed, authed} — installed is a fast fs check; authed comes from the cache
// (recorded by the background fetcher). authed === null means "not checked yet".
function ghMeta() {
  if (!ghInstalled()) return { installed: false, authed: false };
  const meta = loadCache()["__gh__"];
  if (meta && typeof meta.authed === "boolean") return { installed: true, authed: meta.authed };
  return { installed: true, authed: null };
}

function ciState(roll) {
  if (!Array.isArray(roll) || roll.length === 0) return "none";
  let running = false, failed = false, passed = false;
  for (const c of roll) {
    const st = String(c.status || "").toUpperCase();
    const concl = String(c.conclusion || "").toUpperCase();
    const state = String(c.state || "").toUpperCase();
    if (
      ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(concl) ||
      ["FAILURE", "ERROR"].includes(state)
    ) failed = true;
    else if (["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(st) || state === "PENDING")
      running = true;
    else if (concl === "SUCCESS" || state === "SUCCESS") passed = true;
  }
  if (failed) return "failed";
  if (running) return "running";
  if (passed) return "passed";
  return "none";
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}

function atomicWrite(file, obj) {
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function fetchRunning() {
  try { return Date.now() - fs.statSync(LOCK).mtimeMs < SPAWN_GUARD_MS; } catch { return false; }
}

// Read cached states instantly; spawn a detached background refresh for stale urls.
function prStates(urls) {
  const uniq = [...new Set(urls)];
  const cache = loadCache();
  // gh missing -> record it for the footer warning and skip spawning a fetch.
  if (!ghInstalled()) {
    if (!cache["__gh__"] || cache["__gh__"].installed !== false) {
      cache["__gh__"] = { installed: false, authed: false, checked_at: Math.floor(Date.now() / 1000) };
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
      atomicWrite(CACHE, cache);
    }
    const none = {};
    for (const u of uniq) none[u] = cache[u] || null;
    return none;
  }
  const now = Date.now();
  const stale = uniq.filter(
    (u) => !cache[u] || now - (cache[u].fetched_at || 0) * 1000 > TTL_MS
  );
  // also (re)check gh auth periodically even if PR states are fresh
  const ghMetaRow = cache["__gh__"];
  const ghStale = !ghMetaRow || now - (ghMetaRow.checked_at || 0) * 1000 > TTL_MS;
  if ((stale.length || ghStale) && !fetchRunning()) {
    try {
      const child = spawn(process.execPath, [CLI, "fetch", ...stale], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {}
  }
  const out = {};
  for (const u of uniq) out[u] = cache[u] || null;
  return out;
}

// Fetch state for the given PR urls and write the cache (runs in the background).
function fetchAndCache(urls) {
  const list = urls.filter((u) => u.startsWith("http")).slice(0, 12);
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  try {
    if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 120000) return;
    fs.writeFileSync(LOCK, String(process.pid));
  } catch {}
  try {
    const cache = loadCache();
    const nowSec = Math.floor(Date.now() / 1000);
    // 1) record gh install + auth status for the footer warning
    let installed = true, authed = true;
    const probe = spawnSync(ghBin(), ["auth", "status"], {
      encoding: "utf8", timeout: 12000, env: { ...process.env, GH_HOST: "github.com" },
    });
    if (probe.error && probe.error.code === "ENOENT") { installed = false; authed = false; }
    else if (probe.status !== 0) { authed = false; }
    cache["__gh__"] = { installed, authed, checked_at: nowSec };
    atomicWrite(CACHE, cache);
    if (!installed || !authed) return; // can't fetch PR state without a working gh
    // 2) fetch each PR's state
    for (const url of list) {
      let info;
      const r = spawnSync(
        ghBin(),
        ["pr", "view", url, "--json", "state,isDraft,reviewDecision,mergedAt,statusCheckRollup"],
        { encoding: "utf8", timeout: 25000, env: { ...process.env, GH_HOST: "github.com" } }
      );
      if (r.status === 0 && r.stdout) {
        try {
          const d = JSON.parse(r.stdout);
          info = {
            state: d.state,
            isDraft: !!d.isDraft,
            review: d.reviewDecision || null,
            ci: ciState(d.statusCheckRollup),
            error: null,
          };
        } catch (e) {
          info = { error: "parse" };
        }
      } else {
        info = { error: ((r.stderr || "gh error").trim() || "gh error").slice(0, 80) };
      }
      info.fetched_at = nowSec;
      cache[url] = info;
      atomicWrite(CACHE, cache); // incremental so the footer sees progress
    }
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

module.exports = {
  sessionArtifacts, prStates, fetchAndCache, ghInstalled, ghMeta,
  loadConfig, saveConfig, CACHE, CACHE_DIR, CONFIG,
};
