// Repo launcher (cmd-o) and new-task dialog (cmd-shift-n, via the `task` mod).
// Pick: type to filter the repos in ROOT, ↑/↓ to choose. Enter goes to the
// repo's space, or makes one with Claude in it; shift+Enter makes it with a
// plain shell; cmd+Enter (or Tab) starts a task in that repo instead.
// Task: a fresh worktree off the repo's default branch (origin/HEAD) in
// ~/.herdr/worktrees/<repo>/<branch>, as a new space with Claude given the task.
// props: { action?: "pick" | "task" } ("task" starts on the focused space's repo).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, focused, exec, home, shared, setShared } from "herdr";

const ROOT = (h) => `${h}/cooper-square-technologies`;
const WORKTREES = (h) => `${h}/.herdr/worktrees`;
const AGENT = ["claude"];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
// "fix the login redirect loop on web" -> "fix-the-login-redirect-loop"
const branchFor = (prefix, task) => {
  const words = slug(task).split("-").filter(Boolean).slice(0, 5).join("-").slice(0, 40).replace(/-+$/, "");
  return words ? `${prefix}/${words}` : "";
};
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

async function git(cwd, args, timeout) {
  const r = await exec("git", args, { cwd, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The main checkout a folder belongs to (a worktree resolves to its repo), or null.
async function mainCheckout(folder) {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  return common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
}

// The space whose first terminal sits in the repo's main checkout (not a worktree of it).
function spaceFor(path) {
  const all = panes();
  return spaces().find((s) => {
    if (s.machine) return false;
    const tabs = new Set(s.tabs.map((c) => c.id));
    const at = all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
    return at && inside(at, path) && !inside(at, WORKTREES(home()));
  });
}

export default class Repos extends View {
  init(_props, cx) {
    this.home = home();
    this.step = "pick";
    this.repos = undefined; // [{ name, path }] once listed
    this.at = 0;
    this.repo = null; // the task's repo
    this.base = null; // e.g. "origin/dev"
    this.prefix = "";
    this.busy = false;
    this.error = "";
    this.branchEdited = false;
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.filter = InputState.new({ placeholder: "Go to a repo…" });
    this.filter.on("change", (_e, cx) => { this.at = 0; cx.notify(); });
    this.filter.on("submit", (e, cx) => this.pick(this.shown()[this.at], e.secondary ? "task" : e.shift ? "shell" : "agent", cx));
    this.task = InputState.new({ placeholder: "What should Claude do?" });
    this.task.on("change", (_e, cx) => {
      if (!this.branchEdited) this.branch.set_value(branchFor(this.prefix, this.task.value()));
      this.error = "";
      cx.notify();
    });
    this.task.on("submit", (_e, cx) => this.start(cx));
    this.branch = InputState.new({ placeholder: "branch (from the task)" });
    this.branch.on("change", (_e, cx) => { this.branchEdited = this.branch.value() !== branchFor(this.prefix, this.task.value()); this.error = ""; cx.notify(); });
    this.branch.on("submit", (_e, cx) => this.start(cx));
    this.handle.focus();
    this.filter.focus();

    cx.spawn(async (cx) => {
      const user = await exec("git", ["config", "user.name"]);
      this.prefix = slug(user.stdout ?? "") || "task";
      if (props()?.action === "task") {
        const cwd = focused()?.cwd;
        const path = cwd ? await mainCheckout(cwd) : null;
        if (path) return this.toTask({ name: path.split("/").pop(), path }, cx);
        this.error = "This space isn't in a repo: pick one, then cmd+Enter.";
      }
      const r = await exec("sh", ["-c", 'for d in "$1"/*/; do [ -e "$d.git" ] && basename "$d"; done', "sh", ROOT(this.home)]);
      const recent = shared("repos.recent") ?? [];
      const rank = (n) => { const i = recent.indexOf(n); return i < 0 ? Infinity : i; };
      this.repos = (r.stdout ?? "").split("\n").filter(Boolean)
        .map((name) => ({ name, path: `${ROOT(this.home)}/${name}` }))
        .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
      cx.notify();
      cx.timer.after(100, () => this.filter.focus());
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  shown() {
    const f = this.filter.value().trim().toLowerCase();
    return (this.repos ?? []).filter((r) => !f || r.name.toLowerCase().includes(f));
  }

  remember(name) {
    setShared("repos.recent", [name, ...(shared("repos.recent") ?? []).filter((n) => n !== name)].slice(0, 12));
  }

  pick(repo, how, cx) {
    if (!repo) return;
    this.remember(repo.name);
    if (how === "task") return cx.spawn(async (cx) => this.toTask(repo, cx));
    this.close();
    const s = spaceFor(repo.path);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: repo.path, machine: "", ...(how === "agent" ? { argv: AGENT } : {}) });
  }

  async toTask(repo, cx) {
    this.repo = repo;
    this.step = "task";
    this.error = "";
    this.base = null;
    cx.notify();
    this.task.focus();
    cx.timer.after(100, () => this.task.focus());
    const head = await git(repo.path, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    this.base = head.ok ? head.out : "HEAD";
    cx.notify();
  }

  start(cx) {
    if (this.busy || this.step !== "task" || !this.base) return;
    const task = this.task.value().trim();
    const branch = this.branch.value().trim();
    if (!task) { this.error = "Describe the task."; return cx.notify(); }
    if (!branch) { this.error = "Name the branch."; return cx.notify(); }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.error = await this.create(task, branch); }
      catch (e) { this.error = String(e); }
      this.busy = false;
      if (!this.error) this.close();
      cx.notify();
    });
  }

  async create(task, branch) {
    const repo = this.repo;
    const path = `${WORKTREES(this.home)}/${repo.name}/${slug(branch.replace(/\//g, "-"))}`;
    if (this.base.startsWith("origin/")) await git(repo.path, ["fetch", "--quiet", "origin", this.base.slice(7)], 60_000).catch(() => {});
    const exists = (await git(repo.path, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
    // --no-track: `git push -u` later sets the upstream to the task's own branch, not the base.
    const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "--no-track", "-b", branch, path, this.base];
    const r = await git(repo.path, add, 600_000);
    if (!r.ok) return r.err || "git worktree add failed.";
    // Unnamed, so the sidebar nests it under its repo and calls it by its branch.
    run("space.new", { folder: path, machine: "", argv: AGENT, task });
    return "";
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.step === "task" && props()?.action !== "task") {
        this.step = "pick";
        this.error = "";
        this.filter.focus();
      } else return this.close();
    } else if (this.step === "pick") {
      const n = this.shown().length;
      if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else if (e.key === "tab") return this.pick(this.shown()[this.at], "task", cx);
      else return;
      this.scroll.scroll_to_item(this.at);
    } else if (e.key === "tab") {
      this.onBranch = !this.onBranch;
      (this.onBranch ? this.branch : this.task).focus();
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  field(t, label, state) {
    return v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(Input.new(state).h(32).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground));
  }

  renderPick(t) {
    const rows = this.shown();
    const row = (r, i) => {
      const s = spaceFor(r.path);
      return h_flex().id(`repo-${r.name}`).flex_none().h(32).px(10).gap(10).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.selected))
        .when(i !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pick(r, "agent", cx))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.name))
        .when(Boolean(s), (el) => el.child(div().flex_none().text_size(11).text_color(s.status ? t[s.status] : t.accent).child(s.status === "blocked" ? "needs you" : "open")));
    };
    return v_flex().gap(10).flex_1().min_h(0)
      .child(Input.new(this.filter).h(34).px(10).items_center().rounded(8).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(
        v_flex().id("repo-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
          .when(this.repos === undefined, (el) => el.child(div().p(10).text_color(t.muted).child("…")))
          .when(this.repos !== undefined && rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching repos.")))
          .children(rows.map(row)),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↵ open with Claude · ⇧↵ shell · ⌘↵ new task · esc close"));
  }

  renderTask(t) {
    return v_flex().gap(12).flex_1().min_h(0)
      .child(div().text_color(t.muted).child(this.base ? `New worktree off ${this.base}, in a new space with Claude.` : "…"))
      .child(this.field(t, "Task", this.task))
      .child(this.field(t, "Branch", this.branch))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex().justify_end().gap(6).text_size(11).text_color(t.dim)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(this.busy ? "making the worktree…" : `↵ start · tab next field · esc ${props()?.action === "task" ? "close" : "back"}`),
      );
  }

  render() {
    const t = theme();
    const title = this.step === "task" ? `New task in ${this.repo?.name ?? ""}` : "Repos";
    return v_flex().id("repos").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(div().flex_none().font_semibold().text_size(15).text_color(t.foreground).child(title))
      .child(this.step === "task" ? this.renderTask(t) : this.renderPick(t));
  }
}
