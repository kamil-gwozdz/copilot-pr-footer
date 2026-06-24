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

// Return [{kind, url, origin}] for artifacts the session created or updated,
// newest last. origin is "created" or "updated" (created wins if both).
function sessionArtifacts(transcriptPath) {
  if (!transcriptPath) return [];
  const ev = path.join(transcriptPath, "events.jsonl");
  let data;
  try {
    data = fs.readFileSync(ev, "utf8");
  } catch {
    return [];
  }
  const flagged = new Map(); // toolCallId -> [origin, command]
  const originOf = new Map(); // url -> "created" | "updated"
  const kindOf = new Map();
  const order = [];
  for (const line of data.split("\n")) {
    // Only tool-execution events matter. "tool.execution_start" is a substring of
    // "...started" and "tool.execution_complete" of "...completed", so these cover
    // both naming variants.
    const isStart = line.indexOf("tool.execution_start") !== -1;
    const isComplete = !isStart && line.indexOf("tool.execution_complete") !== -1;
    if (!isStart && !isComplete) continue;
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
        if (!["pr", "issue", "gist", "codespace"].includes(kind)) continue;
        const tag = origin === "create" ? "created" : "updated";
        if (!originOf.has(url)) {
          order.push(url);
          kindOf.set(url, kind);
          originOf.set(url, tag);
        } else if (tag === "created") {
          originOf.set(url, "created"); // upgrade update -> created
        }
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
