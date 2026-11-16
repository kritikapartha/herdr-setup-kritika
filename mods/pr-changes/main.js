// Changes, as the PR sees them: everything on this branch since it left its
// base (commits and uncommitted work), not only what's uncommitted. The base is
// the open PR's (gh pr view), else the repo's default branch (origin/HEAD);
// on the base branch itself, it's uncommitted changes as before.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

// A branch with no PR yet asks gh again after this long.
const PR_RECHECK = 120000;

function focusedLocation() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    // Follow: the diff shows whichever file changed last, at its newest edit. Picking a file pauses it.
    this.follow = true; this.diffScroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // The focused pane's folder, unless a worktree chip was clicked; moving focus follows it again.
  location() {
    const here = focusedLocation();
    if (this.picked && this.picked.from !== JSON.stringify(here)) this.picked = null;
    return this.picked ? { cwd: this.picked.path, on: here.on } : here;
  }

  key() {
    return JSON.stringify(this.location());
  }

  pickTree(path, cx) {
    this.picked = path === this.hereRoot ? null : { path, from: JSON.stringify(focusedLocation()) };
    this.refresh(cx);
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const changed = (await watchFolder(root)).map((p) => p.slice(root.length + 1)).filter((p) => p && !p.startsWith(".git/"));
          if (changed.length) this.lastChanged = changed[changed.length - 1];
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = this.location(), context = this.key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false; this.follow = true; this.lastChanged = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        // Every checkout of this repo: { path, label, at }, the one shown first, then the latest commit.
        const trees = (await git(["worktree", "list", "--porcelain"])).stdout.split(/\n\n+/).map((block) => {
          const lines = block.split("\n");
          if (lines.some((l) => l === "bare" || l.startsWith("prunable"))) return null;
          const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
          const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5);
          const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
          return path ? { path, head, label: branch ? branch.replace(/^[^/]+\//, "") : path.split("/").pop() } : null;
        }).filter(Boolean);
        const times = new Map((await git(["log", "--no-walk", "--format=%H %ct", ...new Set(trees.map((w) => w.head).filter(Boolean))])).stdout
          .split("\n").map((l) => l.split(" ")).map(([h, at]) => [h, Number(at) || 0]));
        trees.sort((a, b) => (b.path === root) - (a.path === root) || (times.get(b.head) ?? 0) - (times.get(a.head) ?? 0));
        if (!this.picked) this.hereRoot = root;
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const pr = head.code === 0 ? await this.prBase(root, on) : null;
        let since = "HEAD", ahead = 0;
        if (pr?.ref && pr.ref !== `origin/${pr.branch}`) {
          const mb = await git(["merge-base", "HEAD", pr.ref]);
          if (mb.code === 0) {
            since = mb.stdout.trim();
            ahead = Number((await git(["rev-list", "--count", `${since}..HEAD`])).stdout.trim()) || 0;
          }
        }
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", since, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const byPath = new Map();
        // Committed on the branch, plus tracked edits since: one diff against the fork point.
        if (since !== "HEAD") {
          const names = await git(["diff", since, "--name-status", "-z", "--no-renames"]);
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0");
          for (let i = 0; i + 1 < parts.length; i += 2) {
            const s = parts[i][0] === "A" || parts[i][0] === "D" ? parts[i][0] : "M";
            byPath.set(parts[i + 1], { path: parts[i + 1], status: s, fresh: false });
          }
        }
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          // A file the branch added stays "A" while you keep editing it.
          if (!byPath.has(path) || conflict || fresh) byPath.set(path, { path, status: s, fresh });
        }
        const all = [...byPath.values()];
        const files = all.slice(0, 1000).map((f) => ({ ...f, ...(stats[f.path] ?? { add: 0, del: 0 }) }));
        if (this.key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = all.length > 1000; this.error = null;
        this.since = since; this.ahead = ahead; this.pr = pr; this.trees = trees;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        if (this.follow && files.some((f) => f.path === this.lastChanged)) this.open = this.lastChanged;
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // The branch's PR and the ref it merges into: { branch, ref, number?, url? }.
  // Kept per checkout and branch; a branch with no PR asks again now and then.
  async prBase(root, on) {
    const branch = (await exec("git", [...READ, "branch", "--show-current"], { cwd: root, on })).stdout.trim();
    const id = `${on ?? ""}:${root}@${branch}`, c = this.prCache;
    if (c && c.id === id && (c.number || Date.now() - c.at < PR_RECHECK)) return c;
    let found = null;
    if (branch) {
      try {
        const r = await exec("gh", ["pr", "view", "--json", "number,baseRefName,url,state"], { cwd: root, on, timeout: 15000 });
        const p = r.code === 0 ? JSON.parse(r.stdout) : null;
        if (p && p.state === "OPEN") found = { number: p.number, url: p.url, ref: `origin/${p.baseRefName}` };
      } catch {}
    }
    if (!found) {
      const h = await exec("git", [...READ, "rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: root, on });
      found = { ref: h.code === 0 ? h.stdout.trim() : null };
    }
    this.prCache = { id, branch, at: Date.now(), ...found };
    return this.prCache;
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? [this.since ?? "HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.key() !== context || this.open !== path) return;
    const before = this.shown === path ? this.rows : [];
    this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
    this.shown = path;
    // Same file, new edit: center the first row that differs from last time.
    if (this.follow && before.length) {
      const at = this.rows.findIndex((row, i) => row.text !== before[i]?.text);
      if (at >= 0) this.diffScroll.scroll_to_item(at, "center");
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null; this.follow = false; this.shown = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (this.key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(this.pr?.number ? `PR #${this.pr.number}` : "Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .when(this.since && this.since !== "HEAD", (el) => el.child(div().id("pr-base").min_w(0).truncate().text_size(11).text_color(t.dim)
          .when(Boolean(this.pr?.url), (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => exec("open", [this.pr.url])))
          .child(`${this.ahead} commit${this.ahead === 1 ? "" : "s"} → ${this.pr.ref.replace(/^origin\//, "")}`)))
        .child(div().flex_1())
        .child(div().id("follow").px(6).py(1).rounded(4).text_size(10).cursor_pointer().border_1()
          .border_color(this.follow ? t.accent : t.border).text_color(this.follow ? t.accent : t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.follow = !this.follow; this.refresh(cx); cx.notify(); }).child("Follow"))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      // A fixed-height box: the scroll wrapper otherwise takes a flex share of the panel.
      .when((this.trees?.length ?? 0) > 1, (el) => el.child(div().flex_none().h(32).border_b(1).border_color(t.border).child(h_flex().id("trees").size_full().px(10).gap(4).items_center().overflow_x_scrollbar()
        .children(this.trees.map((w) => {
          const on = w.path === this.root;
          return div().id(`tree-${w.path}`).flex_none().px(7).py(2).rounded(5).text_size(11).cursor_pointer().max_w(180).truncate()
            .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.pickTree(w.path, cx))
            .child((w.path === this.hereRoot && this.picked ? "• " : "") + w.label);
        })))))
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.since && this.since !== "HEAD" ? `No changes vs ${this.pr.ref}` : "No uncommitted changes") : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).track_scroll(this.diffScroll).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
