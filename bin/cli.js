#!/usr/bin/env node
"use strict";
// copilot-pr-footer — show the PRs/issues/gists your Copilot CLI session created or
// updated (with live CI/review/merge state) in the Copilot status-line footer.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  sessionArtifacts, eventsReady, prStates, fetchAndCache, ghInstalled, ghMeta,
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

// OSC-8 hyperlinks are ON by default (clickable PRs). The Copilot CLI renders them
// fine in the live status-line region, but when a footer row scrolls into the
// terminal scrollback the host re-clamps it to the terminal width *counting the
// OSC-8 escape bytes* (URL included). To stay safe we fit the line using that same
// byte-counting model (see hostWidth), so the footer never exceeds the host's budget
// and is never cut mid-hyperlink. Opt out with CX_FOOTER_LINKS=0 or {"links": false}.
function linksEnabled(cfg) {
  const env = process.env.CX_FOOTER_LINKS;
  if (env !== undefined) return !(env === "0" || env.toLowerCase() === "false");
  if (cfg && cfg.links === false) return false;
  return true;
}
let LINKS = true; // set per-render from config/env
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

// Compose chips (each {s, w, prio}) into one line that fits `width` columns. When the
// full line overflows, the least-important chips are rolled up into a single dim "+N"
// counter at a chip boundary (never mid-escape). Priority: closed/merged PRs (prio>=2)
// are collapsed first — as a group — keeping the active/created artifacts; then, if
// still over budget, the remaining chips are dropped from the tail. `hidden` is the
// count already omitted upstream (per-kind cap). width<=0 disables truncation.
const SEP = "  ";
function composeLine(chips, hidden, width) {
  const marker = (n) => `${DIM}+${n}${RESET}`;
  const render = (sel) => {
    let line = sel.map((c) => c.s).join(SEP);
    const dropped = chips.length - sel.length + hidden;
    if (dropped > 0) line += `${sel.length ? " " : ""}${marker(dropped)}`;
    return line;
  };
  let sel = chips.map((c, i) => ({ ...c, i }));
  if (!width || width <= 0) return render(sel);

  const budget = Math.max(1, width - 1); // leave the last column untouched
  const widthOf = (s) => s.reduce((n, c) => n + c.w, 0) + Math.max(0, s.length - 1) * SEP.length;
  const reserveOf = (s) => {
    const d = chips.length - s.length + hidden;
    return d > 0 ? (s.length ? 1 : 0) + 1 + String(d).length : 0; // [" "]"+"<digits>
  };
  const fits = (s) => widthOf(s) + reserveOf(s) <= budget;

  if (!fits(sel)) {
    // roll up all closed/merged PRs first, but only if something else anchors the line
    const done = sel.filter((c) => (c.prio || 0) >= 2);
    if (done.length && sel.length - done.length >= 1) sel = sel.filter((c) => (c.prio || 0) < 2);
    // drop remaining worst-first (highest prio, then trailing) until it fits
    while (sel.length && !fits(sel)) {
      let w = 0;
      for (let j = 1; j < sel.length; j++) {
        const a = sel[j], b = sel[w];
        if ((a.prio || 0) > (b.prio || 0) || ((a.prio || 0) === (b.prio || 0) && a.i > b.i)) w = j;
      }
      sel.splice(w, 1);
    }
  }
  sel.sort((a, b) => a.i - b.i);
  return render(sel);
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
    if (process.env.CX_FOOTER_HINT !== "0") {
      // Distinguish "still reading the session" (just started/resumed, event log not
      // written yet) from "session has no artifacts" — show a loading hint for the former.
      const msg = eventsReady(tpath) ? "\u2387 no artifacts yet" : "\u2387 loading\u2026";
      process.stdout.write(`${DIM}${msg}${RESET}\n`);
    }
    return;
  }

  const by = {};
  for (const a of arts) (by[a.kind] = by[a.kind] || []).push(a);
  for (const k of Object.keys(by))
    by[k].sort((x, y) => (x.origin === "created" ? 0 : 1) - (y.origin === "created" ? 0 : 1));

  const cfg = loadConfig();
  const showState = process.env.CX_FOOTER_STATE !== "0";
  const prUrls = (by.pr || []).map((a) => a.url);
  const states = showState ? prStates(prUrls) : {};

  const buildChips = (withLinks) => {
    LINKS = withLinks;
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
        const st = k === "pr" ? states[a.url] : null;
        const b = k === "pr" ? badge(st) : "";
        let s = `${mark}${text} ${b}`.trimEnd();
        if (idx === 0) s = `${FG[k]}${ICON[k]}${RESET} ` + s; // group icon on first item
        const term = st && /^(CLOSED|MERGED)$/i.test(String(st.state || ""));
        chips.push({ s, w: hostWidth(s), prio: term ? 2 : 0 });
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
      if (warn) chips.push({ s: warn, w: hostWidth(warn), prio: 0 });
    }
    return { chips, hidden };
  };

  const width = resolveWidth(payload, cfg);
  const wantLinks = linksEnabled(cfg);
  let { chips, hidden } = buildChips(wantLinks);
  let line = composeLine(chips, hidden, width);
  // If hyperlinks are so wide they collapse the line to nothing but a counter, fall
  // back to plain-text labels for this render so at least the labels stay visible.
  const onlyCounter = new RegExp("^(?:" + ESC + "\\[[0-9;]*m)*\\+\\d+(?:" + ESC + "\\[[0-9;]*m)*$");
  if (wantLinks && onlyCounter.test(line)) {
    const plain = buildChips(false);
    const plainLine = composeLine(plain.chips, plain.hidden, width);
    if (!onlyCounter.test(plainLine)) line = plainLine;
  }
  process.stdout.write(line + "\n");
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
