// Review, in three roles:
// - the right sidebar: the changed files of the focused terminal's repo (a review tab's terminal while one is focused);
//   clicking a file opens it in that terminal's review tab;
// - a review tab, tied to one terminal (props.agent): every changed file's diff in one list, with line comments
//   sent to that agent; read-only while the terminal runs no agent;
// - a launcher (mod.open, cmd-shift-g): opens or shows the focused terminal's review tab, then closes.
// Shared state: review.mode, review.open (terminal -> {path, at}: the file to jump to), review.comments (repo -> comments),
// review.tabs (terminal -> its tab's name).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, hc, readTextFile, watchFolder, theme, settings, nextCommand, props, run, closeOverlay, notify, shared, setShared } from "herdr";

// GitHub-dark style diff colors.
const C = { add: "#2ea04333", addGutter: "#2ea0434d", del: "#f8514933", delGutter: "#f851494d", hunk: "#388bfd1f", hunkText: "#8fb8ff",
  comment: "#388bfd2e", green: "#3fb950", red: "#f85149", amber: "#d29922" };
const STATUS = { A: C.green, D: C.red, U: C.red, M: C.amber };

const mode = () => shared("review.mode") ?? "branch";
const tied = () => props()?.agent ?? null;
const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const tabsOf = () => shared("review.tabs") ?? {};

// The terminal a review is about: the tab's own; in the sidebar, the focused pane's, or a focused review tab's terminal.
function target() {
  if (tied()) return { terminal: tied(), cwd: panes().find((p) => p.terminal === tied())?.cwd || props().cwd, on: props().on ?? null };
  const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.mod === "review") {
    const name = spaces().flatMap((s) => s.tabs).find((t) => t.id === pane.tab)?.name;
    const hit = Object.entries(tabsOf()).find(([, v]) => v.name === name);
    if (hit) return { terminal: hit[0], cwd: panes().find((p) => p.terminal === hit[0])?.cwd || hit[1].cwd, on: hit[1].on ?? null };
  }
  const space = spaces().find((s) => s.active);
  const on = f?.pane === null ? machineOf(f.terminal) : space?.machine ?? null;
  return { terminal: pane?.terminal ?? f?.terminal ?? null, cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => { const t = target(); return JSON.stringify([t.cwd, t.on, mode()]); };

// Viewed files per repo: path -> the fingerprint of the diff that was viewed, so a change reopens the file.
const viewedOf = (ck) => (shared("review.viewed") ?? {})[ck] ?? {};
function setViewed(ck, map) {
  const all = { ...(shared("review.viewed") ?? {}) };
  if (Object.keys(map).length) all[ck] = map; else delete all[ck];
  setShared("review.viewed", all);
}
const fingerprint = (lines) => {
  let h = 5381;
  for (const l of lines) { for (let i = 0; i < l.length; i++) h = (h * 33 + l.charCodeAt(i)) | 0; h = (h * 33 + 10) | 0; }
  return `${(h >>> 0).toString(36)}:${lines.length}`;
};
const ROW = 20, HEAD = 36; // a file header is a 6px gap plus a 30px bar

const commentsOf = (ck) => (shared("review.comments") ?? {})[ck] ?? [];
function setComments(ck, list) {
  const all = { ...(shared("review.comments") ?? {}) };
  if (list.length) all[ck] = list; else delete all[ck];
  setShared("review.comments", all);
}

// Opens the terminal's review tab, or shows it, at `path` when given, with the file list beside it.
function openTab(path) {
  const t = target();
  if (!t.terminal) { notify({ title: "Focus a terminal first", body: "A review tab belongs to the terminal it was opened from.", level: "warning" }); return; }
  if (path) setShared("review.open", { ...(shared("review.open") ?? {}), [t.terminal]: { path, at: Date.now() } });
  const tabs = { ...tabsOf() }, space = spaces().find((s) => s.active);
  const existing = tabs[t.terminal] && space?.tabs.find((x) => x.name === tabs[t.terminal].name);
  if (existing) run("tab.select", { id: existing.id });
  else {
    const pane = panes().find((p) => p.terminal === t.terminal), tab = space?.tabs.find((x) => x.id === pane?.tab);
    let name = `Review · ${tab?.named ? tab.name : pane?.program?.name ?? t.terminal}`;
    // shortcut: tab names tie review tabs to terminals, so renaming a review tab unties it; tie by pane id if Herdr exposes one.
    if (Object.entries(tabs).some(([k, v]) => k !== t.terminal && v.name === name)) name += ` (${t.terminal})`;
    tabs[t.terminal] = { name, cwd: t.cwd, on: t.on };
    setShared("review.tabs", tabs);
    run("tab.new", { space: space?.id, name, mod: "review", props: { agent: t.terminal, cwd: t.cwd, on: t.on } });
  }
  run("layout.select", { stack: "panel-body", child: "changes" });
  run("layout.show", { id: "panel" });
}

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const letter = (s) => (s[0] === "U" ? "U" : s[0] === "D" ? "D" : s[0] === "A" ? "A" : "M");
const MAX_FILE = 5000, MAX_TOTAL = 50000, MAX_NEW = 200;
// Folded until clicked: lockfiles, snapshots, minified files (and any diff over 1,000 lines).
const BULKY = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|[^/]*\.lock|[^/]*\.snap|[^/]*\.min\.(js|css))$/;

// Splits `git diff --no-renames` output by file: "diff --git a/<p> b/<p>" has the same path twice.
// shortcut: paths git still quotes (control characters, quotes) get no diff text; parse the quoting if that shows up.
export function splitDiff(raw) {
  const out = {};
  let cur = null;
  for (const line of raw.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git a/")) {
      const rest = line.slice(11), n = (rest.length - 5) / 2;
      cur = Number.isInteger(n) && rest.slice(n + 2, n + 5) === " b/" ? rest.slice(2, n + 2) : null;
      if (cur !== null) out[cur] = [];
    } else if (cur !== null) out[cur].push(line);
  }
  return out;
}

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

// Where a comment points: "app/x.py:42" or "app/x.py:10-14"; only removed lines count in the old file.
export function anchor(path, rows) {
  const nums = rows.map((r) => r.number).filter((n) => n !== undefined);
  const at = nums.length ? (nums[0] === nums.at(-1) ? `${nums[0]}` : `${nums[0]}-${nums.at(-1)}`) : "";
  return `${path}${at ? `:${at}` : ""}${rows.every((r) => r.kind === "-") ? " (removed)" : ""}`;
}

export function message(comments) {
  return ["Review comments:", ...comments.map((c) => `- ${c.at}${c.quote ? ` \`${c.quote}\`` : ""} — ${c.text}`)].join("\n");
}

if (anchor("a.py", [{ kind: "+", number: 4 }, { kind: "+", number: 6 }]) !== "a.py:4-6"
  || anchor("a.py", [{ kind: "-", number: 9 }]) !== "a.py:9 (removed)"
  || message([{ at: "a.py:4", quote: "x = 1", text: "why?" }]) !== "Review comments:\n- a.py:4 `x = 1` — why?"
  || JSON.stringify(splitDiff("diff --git a/x y b/x y\n--- a/x y\n+++ b/x y\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/z b/z\n@@ -0,0 +1 @@\n+c\n"))
    !== JSON.stringify({ "x y": ["--- a/x y", "+++ b/x y", "@@ -1 +1 @@", "-a", "+b"], z: ["@@ -0,0 +1 @@", "+c"] })) throw new Error("review self-check failed");

export default class Review extends View {
  init(_props, cx) {
    if (props()?.overlay && !tied()) {
      this.launcher = true;
      cx.spawn(async () => { openTab(); closeOverlay(props().overlay); });
      return;
    }
    this.files = []; this.rows = []; this.auto = new Set(); this.fold = {}; this.message = ""; this.handle = cx.focus_handle();
    this.commentsKey = null; this.sel = null; this.editing = null; this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.commentInput = InputState.new({ placeholder: "Comment · Enter saves · ⌘Enter saves and sends · Esc cancels" });
    this.commentInput.on("submit", (e, cx) => this.saveComment(cx, e?.secondary));
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // The sticky header follows the list's first visible row, which the list reports while drawing (no re-render there).
    if (tied()) cx.timer.every(150, (cx) => { if (this.visibleStart !== this.stickyAt) cx.notify(); });
    // keys.json "mod:review": review.comment, review.send, review.open
    cx.spawn(async (cx) => {
      for (;;) {
        const command = (await nextCommand()).split(/[.:]/).pop();
        if (command === "comment") this.startComment(cx);
        if (command === "send") this.send(cx);
        if (command === "open") openTab();
        if (command === "viewed") this.toggleViewed(cx);
        if (command === "only") this.toggleOnly(cx);
        cx.notify();
      }
    });
  }

  comments() { return commentsOf(this.commentsKey); }

  // Comments need an agent behind the tab; checked live, so starting Claude there turns them on.
  canComment() { return Boolean(tied() && panes().find((p) => p.terminal === tied())?.status); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = target(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.sel = null; this.editing = null;
      this.rows = []; this.sig = null; this.fold = {}; this.cut = false; this.pr = null;
      this.headers = null; this.only = null; this.memo = null; this.visibleStart = 0;
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.done = null; this.watched = null; this.limited = false;
      this.commentsKey = null; this.baseNote = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.rows = []; this.sig = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        // Branch mode compares with where this branch left its PR's base branch (stacked PRs), else origin's default.
        let base = null;
        this.baseName = null;
        if (mode() === "branch" && head.code === 0) {
          const prBase = this.pr?.data?.baseRefName;
          for (const ref of [...(prBase ? [`origin/${prBase}`] : []), "origin/HEAD", "origin/main"]) {
            const r = await git(["merge-base", "HEAD", ref]);
            if (r.code === 0) { base = r.stdout.trim(); this.baseName = ref === "origin/HEAD" ? (await git(["rev-parse", "--abbrev-ref", "origin/HEAD"])).stdout.trim() || ref : ref; break; }
          }
        }
        const target = base ?? "HEAD";
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", target, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          // Branch mode: tracked files come from the diff against the base below.
          if (base && !fresh) continue;
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (base) {
          const names = await git(["diff", base, "--name-status", "-z", "--no-renames"]);
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0");
          const tracked = [];
          for (let i = 0; i + 1 < parts.length && tracked.length < 1000; i += 2) {
            if (parts[i + 1]) tracked.push({ path: parts[i + 1], status: letter(parts[i]), fresh: false, ...(stats[parts[i + 1]] ?? { add: 0, del: 0 }) });
          }
          files.unshift(...tracked);
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.target = target; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.baseNote = mode() === "branch" && !base ? "No origin/main to compare with: showing uncommitted changes" : null;
        this.commentsKey = `comments:${JSON.stringify([on, root])}`;
        this.watch(root, cx);
        this.loadPR(root, on, context, cx); // both roles: the PR's base branch decides the file list too
        if (!tied()) return; // The sidebar lists files; only a review tab loads diffs.
        await this.loadAll(context);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Every changed file's diff, in file-list order, each after a header row. Rebuilds only when the diff changed.
  async loadAll(context) {
    const root = this.root, on = this.on, files = this.files;
    const direct = (f) => f.fresh || (!this.hasHead && f.status === "A");
    let raw = "";
    if (files.some((f) => !direct(f))) {
      const r = await exec("git", [...READ, "-c", "core.quotePath=false", "diff", ...(this.hasHead ? [this.target] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      raw = r.stdout;
    }
    const fresh = files.filter(direct).slice(0, MAX_NEW);
    const texts = await Promise.all(fresh.map((f) => readTextFile(`${root}/${f.path}`, { on }).catch(() => null)));
    const sig = [raw, ...texts, ...files.map((f) => f.path)].join("\u0001");
    if (key() !== context || sig === this.sig) return;
    const parsed = splitDiff(raw), text = new Map(fresh.map((f, n) => [f.path, texts[n]]));
    const rows = [], auto = new Set();
    let total = 0, cut = false;
    for (const f of files) {
      let lines;
      if (direct(f)) {
        const t = text.get(f.path);
        if (t === undefined) lines = ["Not loaded: too many new files"];
        else if (t === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
        else if (t.includes("\0")) lines = ["Binary file · no text diff"];
        else { f.add = countLines(t); lines = [`@@ -0,0 +1,${f.add} @@`, ...t.slice(0, 400000).replace(/\n$/, "").split("\n").map((l) => `+${l}`)]; }
      } else {
        const all = parsed[f.path] ?? [], first = all.findIndex((l) => l.startsWith("@@"));
        lines = first < 0 ? [f.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
      }
      if (lines.length > 1000 || BULKY.test(f.path)) auto.add(f.path);
      if (lines.length > MAX_FILE) lines = [...lines.slice(0, MAX_FILE), `… cut at ${MAX_FILE.toLocaleString()} lines`];
      if (total + lines.length > MAX_TOTAL) { lines = ["Not shown: this review is over 50,000 lines"]; cut = true; }
      total += lines.length;
      rows.push({ kind: "file", path: f.path, file: f, size: lines.length, hash: fingerprint(lines) });
      for (const r of diffRows(lines.map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l)))) { r.path = f.path; rows.push(r); }
    }
    this.sig = sig; this.rows = rows; this.auto = auto; this.cut = cut; this.sel = null; this.rowsVer = (this.rowsVer ?? 0) + 1;
    this.headers = new Map(rows.filter((r) => r.kind === "file").map((r) => [r.path, r]));
    if (this.only && !this.headers.has(this.only)) this.only = null;
  }

  // The branch's PR (header link, base branch); gh is asked again on a branch change or after 2 minutes.
  // A new base branch reloads the review against it.
  loadPR(root, on, context, cx) {
    if (this.prBusy) return;
    this.prBusy = true;
    cx.spawn(async (cx) => {
      const before = this.pr?.data?.baseRefName ?? null;
      try {
        const branch = (await exec("git", [...READ, "branch", "--show-current"], { cwd: root, on })).stdout.trim();
        if (!branch || /^(main|master)$/.test(branch)) { if (key() === context) this.pr = null; return; }
        if (this.pr?.branch === branch && Date.now() - this.pr.at < 120000) return;
        const r = await exec("gh", ["pr", "view", branch, "--json", "number,url,state,baseRefName"], { cwd: root, on }).catch(() => null);
        // A failed gh call keeps the last answer for this branch.
        const last = this.pr?.branch === branch ? this.pr.data : null;
        if (key() === context) this.pr = { branch, at: Date.now(), data: r?.code === 0 ? JSON.parse(r.stdout) : r?.stderr?.includes("no pull requests") ? null : last };
      } catch { /* no PR link */ }
      finally {
        this.prBusy = false;
        if (key() === context && (this.pr?.data?.baseRefName ?? null) !== before && mode() === "branch") this.refresh(cx);
        cx.notify();
      }
    });
  }

  viewed(path) { const h = this.headers?.get(path); return Boolean(h) && viewedOf(this.commentsKey)[path] === h.hash; }

  // Only-this-file folds the rest; otherwise a click decides, else viewed and bulky files start folded.
  folded(path) {
    if (this.only) return path !== this.only;
    return this.fold[path] ?? (this.viewed(path) || this.auto.has(path));
  }

  // The file at the top of the view (the sticky header's).
  currentPath() {
    const it = this.diffItems?.[this.visibleStart ?? 0];
    return it?.row?.path ?? it?.c?.path ?? this.rows[0]?.path ?? null;
  }

  // A header click: fold or unfold; in only-this-file, switch to that file.
  toggleFile(path) {
    if (this.only) { this.only = path; this.jump = path; } else this.fold[path] = !this.folded(path);
  }

  // cmd-e: mark the top file viewed (folds it, jumps to the next file), or unmark it.
  toggleViewed(cx) {
    const path = tied() && this.currentPath(), h = path && this.headers?.get(path);
    if (!h) return;
    const map = { ...viewedOf(this.commentsKey) }, was = map[path] === h.hash;
    if (was) delete map[path]; else map[path] = h.hash;
    delete this.fold[path];
    if (this.only) this.only = null;
    setViewed(this.commentsKey, map);
    const order = [...this.headers.keys()];
    this.jump = was ? path : order[order.indexOf(path) + 1] ?? path;
    cx.notify();
  }

  // cmd-shift-e: only the top file open; again: back to all files.
  toggleOnly(cx) {
    if (!tied()) return;
    const path = this.only ?? this.currentPath();
    if (!path) return;
    this.only = this.only ? null : path;
    this.jump = path;
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = "commit"; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Click picks a line, shift-click extends the selection within the same file.
  select(i, extend, cx) {
    const row = this.rows[i];
    if (row?.number === undefined) return;
    this.sel = extend && this.sel && this.rows[this.sel.a]?.path === row.path ? { ...this.sel, b: i } : { a: i, b: i };
    this.handle.focus();
    cx.notify();
  }

  selectedRows() {
    if (!this.sel) return [];
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b), path = this.rows[this.sel.a]?.path;
    return this.rows.slice(lo, hi + 1).filter((r) => r.path === path && r.number !== undefined);
  }

  startComment(cx) {
    if (!this.canComment()) return;
    const rows = this.selectedRows();
    if (!rows.length) { this.note = "Select a line first: click it, shift-click for a range"; cx.notify(); return; }
    this.note = null; this.done = null;
    this.editing = { index: -1, path: rows[0].path, rows };
    this.commentInput.set_value("");
    this.commentInput.focus();
    cx.notify();
  }

  editComment(index, cx) {
    if (!this.canComment()) return;
    this.editing = { index };
    this.commentInput.set_value(this.comments()[index]?.text ?? "");
    this.commentInput.focus();
    cx.notify();
  }

  saveComment(cx, andSend) {
    const e = this.editing, text = this.commentInput.value().trim(), list = [...this.comments()];
    if (!e) return;
    if (e.index === -1 && text) {
      const last = e.rows.at(-1), quote = e.rows.find((r) => r.text.trim())?.text.trim().replace(/`/g, "'").slice(0, 80) ?? "";
      list.push({ path: e.path, at: anchor(e.path, e.rows), quote, text, end: { kind: last.kind, number: last.number } });
    } else if (e.index >= 0) {
      if (text) list[e.index] = { ...list[e.index], text }; else list.splice(e.index, 1);
    }
    setComments(this.commentsKey, list);
    this.editing = null; this.sel = null; this.handle.focus();
    if (andSend) this.send(cx);
    cx.notify();
  }

  deleteComment(index, cx) {
    const list = [...this.comments()];
    list.splice(index, 1); this.editing = null;
    setComments(this.commentsKey, list);
    cx.notify();
  }

  // Every comment on this repo in one message to the tab's agent, then back to that agent.
  // A blocked agent refuses it (hc send without --force).
  send(cx) {
    const list = this.comments();
    if (!list.length || this.busy || !tied()) return;
    const pane = panes().find((p) => p.terminal === tied());
    if (!pane?.status) { this.note = `${tied()} isn't running an agent`; cx.notify(); return; }
    const ck = this.commentsKey;
    this.busy = "send"; this.note = null; this.done = null;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", pane.terminal, message(list)]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        setComments(ck, []);
        this.done = `Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${pane.program?.name ?? pane.terminal}`;
        run("tab.select", { id: pane.tab });
        run("pane.focus", { pane: pane.pane });
      } catch (e) { this.note = `Send failed: ${e.message ?? e}`; }
      finally { this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  // Rows are drawn inside the virtual list's layout, where handlers throw: clicks come through clickItem.
  diffRow({ kind, number, text }, selected, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(C.hunk).text_color(C.hunkText).child(text);
    const tint = kind === "+" ? C.add : kind === "-" ? C.del : null, gutter = kind === "+" ? C.addGutter : kind === "-" ? C.delGutter : null;
    return h_flex().w_full().h(20).flex_none()
      .when(Boolean(tint), (e) => e.bg(tint)).when(selected, (e) => e.bg(t.accent + "40"))
      .child(div().w(44).h_full().pr(8).flex_none().flex().items_center().justify_end().text_color(t.dim)
        .when(Boolean(gutter), (e) => e.bg(gutter).text_color(t.foreground)).child(number === undefined ? "" : String(number)))
      .child(div().w(16).flex_none().text_center().text_color(t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // A file header: a gap, then a bar. `extra` (the sticky copy only: handlers can't go inside the list) ends the bar.
  fileRow({ path, file, size }, folded, t, extra) {
    const parts = path.split("/"), name = parts.pop(), viewed = this.viewed(path);
    return div().w_full().h(HEAD).flex_none().pt(6).bg(t.background).child(h_flex().w_full().h(HEAD - 6).pr(10).gap(8).items_center()
      .bg(t.raised).border_t(1).border_b(1).border_color(t.border).text_size(13).cursor_pointer()
      .child(div().w(3).h_full().flex_none().bg(viewed ? C.green : t.accent))
      .child(div().w(12).flex_none().text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(div().w(12).flex_none().font_semibold().text_color(STATUS[file.status] ?? t.dim).child(file.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().font_semibold().text_color(t.foreground).flex_none().child(name)))
      .when(folded && !viewed, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${size.toLocaleString()} lines · folded`)))
      .when(file.add > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(C.green).child(`+${file.add}`)))
      .when(file.del > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(C.red).child(`−${file.del}`)))
      .when(viewed && !extra, (e) => e.child(div().flex_none().px(6).rounded(4).bg(C.add).text_size(11).text_color(C.green).child("✓ Viewed")))
      .when(Boolean(extra), (e) => e.child(extra(viewed))));
  }

  commentRow(c, t) {
    return h_flex().w_full().h(20).flex_none().gap(6).pl(57).pr(8).items_center()
      .bg(C.comment).border_l(3).border_color(t.accent).text_color(t.foreground).font_family(settings().ui_font_family ?? "Geist")
      .child(div().flex_1().min_w(0).truncate().child(`› ${c.text}`));
  }

  // Click a file header to fold it; a line to select it, shift-click to extend, double-click to comment; a comment to edit it.
  clickItem(key, cx) {
    const index = Number(key.slice(1));
    if (key[0] === "h") { const path = this.rows[index]?.path; if (path) { this.toggleFile(path); cx.notify(); } return; }
    if (!this.canComment()) return;
    if (key[0] === "c") { this.editComment(index, cx); return; }
    const now = Date.now(), double = this.lastClick?.key === key && now - this.lastClick.at < 400;
    this.lastClick = { key, at: now };
    this.select(index, this.shift && !double, cx);
    if (double) this.startComment(cx);
  }

  // Header and rows per file (a folded file: its header only). A comment follows the line it ends on, else its
  // file's end (line gone or folded); comments on files no longer changed go last.
  items() {
    const comments = this.comments(), at = new Map(), placed = new Set(), out = [];
    const spot = (path, kind, number) => `${path}\0${kind}\0${number}`;
    comments.forEach((c, index) => { const k = spot(c.path, c.end?.kind, c.end?.number); at.set(k, [...(at.get(k) ?? []), { c, index }]); });
    const rest = (path) => comments.forEach((c, index) => { if (c.path === path && !placed.has(index)) { placed.add(index); out.push({ c, index }); } });
    const lo = this.sel ? Math.min(this.sel.a, this.sel.b) : -1, hi = this.sel ? Math.max(this.sel.a, this.sel.b) : -2;
    let path = null, folded = false;
    this.rows.forEach((row, i) => {
      if (row.kind === "file") {
        if (path !== null) rest(path);
        path = row.path; folded = this.folded(path);
        out.push({ row, i, folded });
      } else if (!folded) {
        out.push({ row, i, selected: i >= lo && i <= hi });
        for (const h of at.get(spot(row.path, row.kind, row.number)) ?? []) if (!placed.has(h.index)) { placed.add(h.index); out.push(h); }
      }
    });
    if (path !== null) rest(path);
    comments.forEach((c, index) => { if (!placed.has(index)) out.push({ c, index }); });
    return out;
  }

  render(cx) {
    if (this.launcher) return div();
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const button = (id, label, on, action) => div().id(id).h(32).px(14).flex().items_center().rounded(8).bg(on ? t.solid : t.raised).text_color(on ? t.solid_foreground : t.dim).text_size(12).when(on, (e) => e.cursor_pointer()).on_click(action).child(label);
    const notes = (el) => el
      .when(this.limited, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).text_size(11).text_color(C.red).child(this.note)))
      .when(Boolean(this.done) && !this.note, (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.dim).child(this.done)));
    const root = v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.editing) { this.editing = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      });
    return tied() ? this.renderTab(root, t, button, notes, cx) : this.renderList(root, t, button, notes);
  }

  // The sidebar: mode, changed files, commit.
  renderList(root, t, button, notes) {
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const openPath = (shared("review.open") ?? {})[target().terminal]?.path;
    const perFile = {};
    for (const c of this.comments()) perFile[c.path] = (perFile[c.path] ?? 0) + 1;
    const modeButton = (id, label) => div().id(`mode-${id}`).px(6).py(1).rounded(4).text_size(10.5).cursor_pointer()
      .when(mode() === id, (e) => e.bg(t.selected).text_color(t.foreground))
      .when(mode() !== id, (e) => e.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click(() => setShared("review.mode", id)).child(label);
    return notes(root
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Review"))
        .child(h_flex().gap(2).child(modeButton("branch", "Branch")).child(modeButton("uncommitted", "Uncommitted")))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(C.green).child(`+${add}`)).child(div().text_size(11).text_color(C.red).child(`−${del}`)))
      .when(Boolean(this.baseNote), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.baseNote)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
          const parts = f.path.split("/"), name = parts.pop();
          return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .when(openPath === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(() => openTab(f.path))
            .child(div().w(14).text_size(11).font_semibold().text_color(STATUS[f.status] ?? t.dim).child(f.status))
            .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
            .when(Boolean(perFile[f.path]), (e) => e.child(div().px(4).rounded(4).bg(C.comment).text_size(10.5).text_color(t.foreground).child(`${perFile[f.path]} ›`)))
            .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(C.green).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(C.red).child(`−${f.del}`)));
        })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (mode() === "branch" ? "No changes on this branch" : "No uncommitted changes") : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0())))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(button("commit", this.busy === "commit" ? "Committing…" : "Commit", enabled, (_e, cx) => this.commit(cx))));
  }

  // The review tab: every file's diff in one scroll, comments and send.
  renderTab(root, t, button, notes, cx) {
    // A sidebar click sets review.open to {path, at}: unfold that file and scroll to its header, once per click.
    const want = (shared("review.open") ?? {})[tied()];
    if (want?.at && want.at !== this.jumped && this.headers?.has(want.path)) {
      this.jumped = want.at; this.jump = want.path;
      if (this.only) this.only = want.path; else this.fold[want.path] = false;
    }
    const can = this.canComment(), list = this.comments(), pr = this.pr?.data, viewedMap = viewedOf(this.commentsKey);
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const viewedCount = [...(this.headers?.values() ?? [])].filter((h) => viewedMap[h.path] === h.hash).length;
    const editingAt = this.editing ? (this.editing.index >= 0 ? list[this.editing.index]?.at : anchor(this.editing.path, this.editing.rows)) : null;
    // The virtual list keeps its first callbacks, so they read this.diffItems (live), never a render-local list.
    // Rebuilt only when something it shows changed: wheel and timer re-renders (sticky header) stay cheap.
    const memo = JSON.stringify([this.rowsVer, this.fold, this.only, this.sel, list, viewedMap]);
    if (memo !== this.memo) {
      this.memo = memo;
      this.diffItems = this.items();
      this.sizes = this.diffItems.map((it) => (it.row?.kind === "file" ? HEAD : ROW));
    }
    // "top" only scrolls to the nearest edge. A header above the view lands at the top; for one at or below the top,
    // bring into view the row a screen further down, which leaves the header at the top (under its sticky copy).
    if (this.jump) {
      const i = this.diffItems.findIndex((it) => it.row?.kind === "file" && it.row.path === this.jump);
      this.jump = null;
      if (i >= 0) {
        let j = i, h = this.sizes[i];
        if (i >= (this.visibleStart ?? 0)) while (j + 1 < this.sizes.length && h < (this.areaH ?? 0)) h += this.sizes[++j];
        this.scroll.scroll_to_item(j, "top");
        cx.timer.after(100, (cx) => cx.notify());
      }
    }
    const itemKey = (i) => { const it = this.diffItems[i]; return !it ? `x${i}` : !it.row ? `c${it.index}` : `${it.row.kind === "file" ? "h" : "r"}${it.i}`; };
    const itemRow = (it) => (!it.row ? this.commentRow(it.c, theme()) : it.row.kind === "file" ? this.fileRow(it.row, it.folded, theme()) : this.diffRow(it.row, it.selected, theme()));
    // The list draws once to measure a row (a one-item range): only a real range moves the sticky header.
    const drawRange = (range) => { if (range.end - range.start > 1) this.visibleStart = range.start; return this.diffItems.slice(range.start, range.end).map(itemRow); };
    this.stickyAt = this.visibleStart;
    const stickyPath = this.diffItems.length ? this.currentPath() : null, sticky = stickyPath && this.headers?.get(stickyPath);
    const viewedBox = (viewed) => div().id("sticky-viewed").flex_none().px(8).h(22).flex().items_center().gap(4).rounded(5).border_1()
      .border_color(viewed ? C.green : t.border).bg(viewed ? C.add : t.background).text_size(11).text_color(viewed ? C.green : t.dim).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(cx); }).child(viewed ? "✓ Viewed" : "Viewed ⌘E");
    return notes(root
      .on_modifiers_changed((e) => { this.shift = e.modifiers.shift; })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().flex_none().child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
        .when(this.files.length > 0, (e) => e.child(div().text_size(11).text_color(viewedCount ? C.green : t.dim).child(`${viewedCount}/${this.files.length} viewed`)))
        .when(Boolean(this.only), (e) => e.child(div().id("only").px(6).py(1).rounded(4).bg(t.selected).text_size(11).cursor_pointer()
          .on_click((_e, cx) => this.toggleOnly(cx)).child("one file · ⌘⇧E for all")))
        .when(add > 0, (e) => e.child(div().text_size(11).text_color(C.green).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(11).text_color(C.red).child(`−${del}`)))
        .child(div().text_size(10.5).text_color(t.dim).child(mode() === "branch" ? `vs ${this.baseName ?? "origin/main"}` : "uncommitted"))
        .when(Boolean(pr), (e) => e.child(div().id("pr").px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => { exec("open", [pr.url]).catch(() => null); }).child(`PR #${pr.number}${pr.state === "OPEN" ? "" : ` · ${pr.state.toLowerCase()}`}`)))
        .child(div().flex_1())
        .when(!can, (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child("read-only · not an agent")))
        .when(can && list.length > 0, (e) => e.child(div().id("send").h(26).px(10).flex().items_center().rounded(6).bg(this.busy ? t.raised : t.solid).text_color(this.busy ? t.dim : t.solid_foreground).text_size(12).cursor_pointer()
          .on_click((_e, cx) => this.send(cx)).child(this.busy === "send" ? "Sending…" : `Send ${list.length} ⌘↵`))))
      .when(Boolean(this.baseNote), (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child(this.baseNote)))
      .when(this.cut, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Over 50,000 diff lines: later files show their header only")))
      // No sideways scroll around the list: it took the wheel. Long lines are cut with "…".
      .child(div().id("diff-area").flex_1().min_h(0).min_w(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .on_scroll_wheel((_e, cx) => cx.notify()).on_size_change((size) => { this.areaH = size.height; })
        .child(v_virtual_list("changes-diff", this.diffItems.length, this.sizes, itemKey, drawRange)
          .track_scroll(this.scroll).size_full().on_item_click((key, cx) => this.clickItem(key, cx)))
        // Sticky header: a copy of the top file's header over the list; a click folds that file and goes to its header.
        .when(Boolean(sticky), (e) => e.child(div().id("sticky").absolute().top(0).left(0).right(0)
          .on_click((_e, cx) => { this.toggleFile(stickyPath); this.jump = stickyPath; cx.notify(); })
          .child(this.fileRow(sticky, this.folded(stickyPath), t, viewedBox))))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.files.length, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : "No changes")))))
      .when(Boolean(this.editing), (e) => e.child(v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).child(`Comment on ${editingAt ?? ""}`))
        .child(h_flex().gap(8)
          .child(div().id("comment-input").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.commentInput).h_full().text_size(12).text_color(t.foreground)))
          .when(this.editing?.index >= 0, (e) => e.child(button("comment-delete", "Delete", false, (_e, cx) => this.deleteComment(this.editing.index, cx))))
          .child(button("comment-save", "Save", true, (_e, cx) => this.saveComment(cx, false)))))));
  }
}
