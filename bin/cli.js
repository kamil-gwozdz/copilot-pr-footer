#!/usr/bin/env node
"use strict";
// copilot-pr-footer — show the PRs/issues/gists your Copilot CLI session created or
// updated (with live CI/review/merge state) in the Copilot status-line footer.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  sessionArtifacts, prStates, fetchAndCache, ghInstalled, ghMeta,
  loadConfig, saveConfig,
} = require("../lib/artifacts");

const SETTINGS = path.join(os.homedir(), ".copilot", "settings.json");

// ── ANSI / glyphs ────────────────────────────────────────────────────────────
const ICON = { pr: "\u2387", issue: "\u25cb", gist: "\u2710", codespace: "\u2601" };
const FG = { pr: "\x1b[36m", issue: "\x1b[32m", gist: "\x1b[35m", codespace: "\x1b[34m" };
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", M = "\x1b[35m", B = "\x1b[34m";
const RESET = "\x1b[0m", DIM = "\x1b[2m";
const MARK = { created: `${G}+${RESET}`, updated: `${B}~${RESET}` };
const MAX = 6;

// OSC-8 hyperlinks are opt-in. The Copilot CLI renders them fine in the live
// status-line region, but when a footer row scrolls into the terminal scrollback
// the host re-clamps it to the terminal width *counting the OSC-8 escape bytes*
// (URL included) — so it cuts mid-hyperlink and leaves a dangling escape that
// mangles following rows. Plain-text labels keep the footer's measured width equal
// to its visible width, so the host's clamp is correct. Enable links (clickable
// PRs) via CX_FOOTER_LINKS=1 or {"links": true} in config.json.
function linksEnabled(cfg) {
  const env = process.env.CX_FOOTER_LINKS;
  if (env !== undefined) return env === "1" || env.toLowerCase() === "true";
  return !!(cfg && cfg.links);
}
let LINKS = false; // set per-render from config/env
const link = (url, text) =>
  LINKS ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;

function label(kind, url) {
  const p = url.split("/");
  if (kind === "pr" || kind === "issue") return `${p[4]}#${p[p.length - 1]}`;
  if (kind === "gist") return "gist:" + p[p.length - 1].slice(0, 10);
  if (kind === "codespace") return "codespace";
  return url;
}

function badge(st) {
  if (!st || st.error) return "";
  const state = String(st.state || "").toUpperCase();
  if (state === "MERGED") return `${M}merged${RESET}`;
  if (state === "CLOSED") return `${DIM}closed${RESET}`;
  const parts = [];
  if (st.isDraft) parts.push(`${DIM}draft${RESET}`);
  if (st.ci === "running") parts.push(`${Y}ci\u2026${RESET}`);
  else if (st.ci === "passed") parts.push(`${G}ci\u2713${RESET}`);
  else if (st.ci === "failed") parts.push(`${R}ci\u2717${RESET}`);
  if (st.review === "APPROVED") parts.push(`${G}appr${RESET}`);
  else if (st.review === "CHANGES_REQUESTED") parts.push(`${R}chg${RESET}`);
  else if (st.review === "REVIEW_REQUIRED") parts.push(`${Y}rev?${RESET}`);
  return parts.join(" ");
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

// ── width-aware truncation ───────────────────────────────────────────────────
// Visible (printed) width of a string, ignoring SGR colors and OSC-8 hyperlink
// escapes (so the hyperlink target never counts, only its label does).
const ESC = String.fromCharCode(27);
const OSC8_RE = new RegExp(ESC + "\\]8;;[^" + ESC + "]*" + ESC + "\\\\", "g");
const SGR_RE = new RegExp(ESC + "\\[[0-9;]*m", "g");
function visibleWidth(s) {
  return Array.from(s.replace(OSC8_RE, "").replace(SGR_RE, "")).length;
}

// Width as the host counts it when clamping a scrolled row: it understands SGR
// color codes (zero-width) but NOT OSC-8 hyperlinks, whose bytes it counts. We fit
// to this so the emitted line never exceeds the terminal width in the host's own
// accounting — preventing the mid-hyperlink cut even when links are enabled.
function hostWidth(s) {
  return Array.from(s.replace(SGR_RE, "")).length;
}

// Best-effort terminal columns. The statusLine payload carries no width and the
// command runs with a piped (non-TTY) stdout, so we walk up the process tree to
// the Copilot CLI's controlling TTY and ask `stty` for its size. Unix-only.
function ttyCols() {
  if (process.platform === "win32") return 0;
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 400 })
        .toString().trim();
    } catch { return ""; }
  };
  let pid = process.ppid;
  for (let i = 0; i < 10 && pid > 1; i++) {
    const tty = run("ps", ["-o", "tty=", "-p", String(pid)]);
    if (tty && tty !== "?" && tty !== "??" && tty !== "-") {
      const dev = tty.startsWith("/") ? tty : "/dev/" + tty;
      const size = run("stty", ["-f", dev, "size"]) || run("stty", ["-F", dev, "size"]);
      const cols = parseInt(size.split(/\s+/)[1] || "", 10);
      if (Number.isFinite(cols) && cols > 0) return cols;
    }
    const ppid = parseInt(run("ps", ["-o", "ppid=", "-p", String(pid)]), 10);
    if (!Number.isFinite(ppid) || ppid <= 1 || ppid === pid) break;
    pid = ppid;
  }
  return 0;
}

// Resolve the column budget. Explicit overrides win (CX_FOOTER_WIDTH=0 disables
// truncation), then any width the payload happens to expose, then the live TTY.
// 0 means "unknown" -> render everything and let the host truncate (legacy).
function resolveWidth(payload, cfg) {
  const pos = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
  const envRaw = process.env.CX_FOOTER_WIDTH;
  if (envRaw !== undefined && /^\d+$/.test(envRaw.trim())) return parseInt(envRaw, 10);
  if (pos((cfg || {}).width)) return pos(cfg.width);
  const p = payload || {};
  for (const v of [p.columns, p.cols, p.width, p.terminal_width, p.terminalWidth,
    p.terminal && (p.terminal.columns || p.terminal.width),
    p.screen && (p.screen.columns || p.screen.width)]) {
    if (pos(v)) return pos(v);
  }
  if (process.stdout && pos(process.stdout.columns)) return pos(process.stdout.columns);
  if (pos(process.env.COLUMNS)) return pos(process.env.COLUMNS);
  return ttyCols();
}

// Join chips (each {s, w}) into one line that fits `width` columns. Drops trailing
// chips that don't fit and appends a single dim "+N" overflow counter, always at a
// chip boundary so a hyperlink/label is never cut mid-escape. `hidden` is the count
// of artifacts already omitted (per-kind cap). width<=0 disables truncation.
const SEP = "  ";
function composeLine(chips, hidden, width) {
  const marker = (n) => `${DIM}+${n}${RESET}`;
  const markerVis = (n) => 2 + String(n).length; // " +" + digits
  const joinAll = () => {
    let s = chips.map((c) => c.s).join(SEP);
    if (hidden > 0) s += ` ${marker(hidden)}`;
    return s;
  };
  if (!width || width <= 0) return joinAll();

  const budget = Math.max(1, width - 1); // leave the last column untouched
  const fullVis = chips.reduce((n, c) => n + c.w, 0)
    + Math.max(0, chips.length - 1) * SEP.length
    + (hidden > 0 ? markerVis(hidden) : 0);
  if (fullVis <= budget) return joinAll();

  const shown = [];
  let used = 0;
  for (let i = 0; i < chips.length; i++) {
    const lead = shown.length ? SEP.length : 0;
    const willDrop = hidden + (chips.length - 1 - i);
    const reserve = willDrop > 0 ? markerVis(willDrop) : 0;
    if (used + lead + chips[i].w + reserve <= budget) {
      shown.push(chips[i].s); used += lead + chips[i].w;
    } else break;
  }
  const total = hidden + (chips.length - shown.length);
  let line = shown.join(SEP);
  if (total > 0) line += `${shown.length ? " " : ""}${marker(total)}`;
  return line;
}

// ── render: the statusLine command ───────────────────────────────────────────
function render() {
  let payload = {};
  const raw = readStdin();
  if (raw.trim()) { try { payload = JSON.parse(raw) || {}; } catch {} }
  let sid = payload.session_id || process.argv[3] || "";
  let tpath = payload.transcript_path;
  if (!tpath && sid) tpath = path.join(os.homedir(), ".copilot", "session-state", sid);
  if (!tpath) return;

  const arts = sessionArtifacts(tpath);
  if (!arts.length) {
    if (process.env.CX_FOOTER_HINT !== "0")
      process.stdout.write(`${DIM}\u2387 no artifacts yet${RESET}\n`);
    return;
  }

  const by = {};
  for (const a of arts) (by[a.kind] = by[a.kind] || []).push(a);
  for (const k of Object.keys(by))
    by[k].sort((x, y) => (x.origin === "created" ? 0 : 1) - (y.origin === "created" ? 0 : 1));

  const cfg = loadConfig();
  LINKS = linksEnabled(cfg);
  const showState = process.env.CX_FOOTER_STATE !== "0";
  const prUrls = (by.pr || []).map((a) => a.url);
  const states = showState ? prStates(prUrls) : {};

  const chips = [];
  let hidden = 0;
  for (const k of ["pr", "issue", "gist", "codespace"]) {
    const entries = by[k];
    if (!entries) continue;
    const shown = entries.slice(0, MAX);
    hidden += entries.length - shown.length;
    shown.forEach((a, idx) => {
      const mark = MARK[a.origin] || "";
      const text = link(a.url, label(k, a.url));
      const b = k === "pr" ? badge(states[a.url]) : "";
      let s = `${mark}${text} ${b}`.trimEnd();
      if (idx === 0) s = `${FG[k]}${ICON[k]}${RESET} ` + s; // group icon on first item
      chips.push({ s, w: hostWidth(s) });
    });
  }

  // graceful gh degradation: warn (once suppressible) if PRs exist but gh can't help
  if (showState && prUrls.length && !cfg.ghWarningDisabled) {
    const meta = ghMeta();
    let warn = "";
    if (!meta.installed) {
      warn = `${Y}\u26a0 gh not installed${RESET}${DIM} \u00b7 PR state hidden \u00b7 https://cli.github.com \u00b7 hide: copilot-pr-footer disable-gh-warning${RESET}`;
    } else if (meta.authed === false) {
      warn = `${Y}\u26a0 gh not authorized${RESET}${DIM} \u00b7 run: gh auth login \u00b7 hide: copilot-pr-footer disable-gh-warning${RESET}`;
    }
    if (warn) chips.push({ s: warn, w: hostWidth(warn) });
  }

  process.stdout.write(composeLine(chips, hidden, resolveWidth(payload, cfg)) + "\n");
}

// ── settings.json wiring ─────────────────────────────────────────────────────
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}
function statusLineCommand() {
  // Prefer the bin name on PATH (update-resilient); fall back to an absolute call.
  // The footer's runtime PATH includes the npm/Homebrew global bin dir.
  return "copilot-pr-footer render";
}

function install() {
  const s = readSettings();
  s.footer = s.footer || {};
  s.footer.showCustom = true;
  s.statusLine = { type: "command", command: statusLineCommand() };
  writeSettings(s);
  console.log("\u2713 copilot-pr-footer installed.");
  console.log("  settings.json statusLine.command = " + JSON.stringify(s.statusLine.command));
  console.log("  Open a new Copilot CLI session (or wait a few seconds) to see the footer.");
  if (!ghInstalled())
    console.log("  Note: `gh` not found \u2014 PR state badges need GitHub CLI: https://cli.github.com");
}

function uninstall() {
  const s = readSettings();
  let changed = false;
  if (s.statusLine && /copilot-pr-footer/.test(s.statusLine.command || "")) {
    delete s.statusLine; changed = true;
  }
  if (changed) writeSettings(s);
  console.log(changed ? "\u2713 copilot-pr-footer removed from settings.json." :
    "Nothing to remove (statusLine was not set by copilot-pr-footer).");
}

function doctor() {
  const s = readSettings();
  const meta = ghMeta();
  console.log("copilot-pr-footer doctor");
  console.log("  node:            " + process.version);
  console.log("  gh installed:    " + (meta.installed ? "yes" : "NO (PR state hidden)"));
  console.log("  gh authorized:   " + (meta.authed === null ? "unknown (checks on next footer tick)" : meta.authed ? "yes" : "NO (run: gh auth login)"));
  console.log("  settings.json:   " + SETTINGS);
  console.log("  statusLine:      " + (s.statusLine ? JSON.stringify(s.statusLine.command) : "(not set \u2014 run: copilot-pr-footer install)"));
  console.log("  footer.showCustom: " + ((s.footer && s.footer.showCustom) ? "true" : "false (run install)"));
  console.log("  gh warning:      " + (loadConfig().ghWarningDisabled ? "disabled" : "enabled"));
}

function setGhWarning(disabled) {
  const cfg = loadConfig();
  cfg.ghWarningDisabled = disabled;
  saveConfig(cfg);
  console.log(disabled ? "\u2713 gh warning hidden." : "\u2713 gh warning re-enabled.");
}

function help() {
  console.log(`copilot-pr-footer \u2014 show PRs/issues/gists your Copilot CLI session
created or updated, with live CI/review/merge state, in the footer.

Usage:
  copilot-pr-footer install              wire it into ~/.copilot/settings.json
  copilot-pr-footer uninstall            remove it from settings.json
  copilot-pr-footer doctor               show status (node, gh, settings)
  copilot-pr-footer disable-gh-warning   hide the "gh not installed/authorized" line
  copilot-pr-footer enable-gh-warning    show it again
  copilot-pr-footer render               (used by the status line; reads stdin JSON)
  copilot-pr-footer fetch <pr-url\u2026>      (internal: refresh PR-state cache)

After install, open a new Copilot CLI session. Requires GitHub CLI (gh) for PR
state badges; without it the footer still lists artifacts and shows a hint.`);
}

if (require.main === module) {
  const cmd = process.argv[2];
  switch (cmd) {
    case "render": render(); break;
    case "fetch": fetchAndCache(process.argv.slice(3)); break;
    case "install": install(); break;
    case "uninstall": uninstall(); break;
    case "doctor": doctor(); break;
    case "disable-gh-warning": setGhWarning(true); break;
    case "enable-gh-warning": setGhWarning(false); break;
    case "postinstall":
      console.log("copilot-pr-footer installed. Run `copilot-pr-footer install` to enable the footer.");
      break;
    default: help();
  }
}

module.exports = { badge, label, visibleWidth, hostWidth, composeLine, resolveWidth, linksEnabled };
