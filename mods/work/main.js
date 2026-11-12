// Work: your GitHub PRs and Linear issues, each tied to the session working on it. One mod, by props:
// - view "badge" (status bar, always on screen): polls GitHub every 2 min and Linear every 5, posts PR alerts,
//   and handles cmd-shift-i / cmd-shift-l (work.prs / work.linear) by showing or hiding that pane;
// - view "prs" / "linear" (right panel stack children): the lists, from what the badge stores;
// - pick (dialog): the repo a Linear team's issues start in.
// Shared: work.prs, work.issues, work.snap (last PR states, for alerts), work.repos (team key -> repo folder).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { panes, spaces, run, exec, hc, home, theme, shared, setShared, notify, nextCommand, props, openOverlay, closeOverlay, layout } from "herdr";

// Settings: change to yours.
const REPOS_DIR = "Developer/repos"; // under your home: where your git clones live, named like their GitHub repos
const BRANCH_PREFIX = "bekzat/"; // Start's new branches: <prefix><issue-key>-<first title words>

const C = { green: "#3fb950", red: "#f85149", amber: "#d29922", blue: "#388bfd" };
const REPOS = () => `${home()}/${REPOS_DIR}`;
const FAILED = new Set(["FAILURE", "ERROR"]);
const activeSpace = () => spaces().find((s) => s.active)?.id;
const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

// The Linear key a branch starts with, after any "<name>/" prefix: bekzatamirbay/aei-2371-x -> AEI-2371.
export const issueKey = (branch) => /^([a-z]+-\d+)(?:-|$)/i.exec((branch ?? "").replace(/^[^/]+\//, ""))?.[1]?.toUpperCase() ?? null;

// ---- GitHub

// Your open PRs and the ones merged in the last 7 days, in one call.
const PR_QUERY = `query($open: String!, $merged: String!) {
  open: search(query: $open, type: ISSUE, first: 50) { nodes { ...pr } }
  merged: search(query: $merged, type: ISSUE, first: 30) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft state headRefName headRefOid baseRefName mergedAt updatedAt
  repository { name nameWithOwner }
  reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
}`;

async function fetchPRs() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const r = await exec("gh", ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", "open=is:pr is:open author:@me archived:false", "-f", `merged=is:pr is:merged author:@me merged:>=${since}`]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  const d = JSON.parse(r.stdout).data;
  const pr = (n) => ({
    number: n.number, title: n.title, url: n.url, draft: n.isDraft, state: n.state, branch: n.headRefName, head: n.headRefOid,
    repo: n.repository.name, owner: n.repository.nameWithOwner, review: n.reviewDecision, updated: n.updatedAt, merged: n.mergedAt,
    ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null, unresolved: n.reviewThreads.nodes.filter((t) => !t.isResolved).length,
  });
  return { at: Date.now(), open: d.open.nodes.filter((n) => n.number).map(pr), merged: d.merged.nodes.filter((n) => n.number).map(pr) };
}

// What changed since the last poll that deserves a notification. A PR seen for the first time alerts nothing.
export function alerts(prev, next) {
  const out = [];
  for (const p of next.open) {
    const o = prev[p.url];
    if (!o) continue;
    if (FAILED.has(p.ci) && p.ci !== o.ci) out.push({ p, body: "CI failed", level: "error" });
    if (p.review !== o.review && (p.review === "APPROVED" || p.review === "CHANGES_REQUESTED")) out.push({ p, body: p.review === "APPROVED" ? "Approved" : "Changes requested", level: p.review === "APPROVED" ? "info" : "warning" });
    if (p.unresolved > o.unresolved) out.push({ p, body: `New review comments: ${p.unresolved} unresolved`, level: "info" });
  }
  for (const p of next.merged) if (prev[p.url]?.state === "OPEN") out.push({ p, body: "Merged", level: "info" });
  return out;
}
const snapshot = (d) => Object.fromEntries([...d.open, ...d.merged].map((p) => [p.url, { ci: p.ci, review: p.review, unresolved: p.unresolved, state: p.state }]));
{
  const p = { url: "u", ci: "FAILURE", review: "APPROVED", unresolved: 2, state: "OPEN" };
  const got = alerts({ u: { ci: "SUCCESS", review: null, unresolved: 1, state: "OPEN" } }, { open: [p], merged: [] }).map((a) => a.body);
  if (got.join("|") !== "CI failed|Approved|New review comments: 2 unresolved" || alerts({}, { open: [p], merged: [] }).length
    || alerts({ u: { state: "OPEN" } }, { open: [], merged: [{ ...p, state: "MERGED" }] })[0]?.body !== "Merged"
    || issueKey("bekzatamirbay/aei-2371-x") !== "AEI-2371" || issueKey("devin/1794-x") !== null) throw new Error("work self-check failed");
}

// Polls and stores PRs; the badge also posts alerts and moves the snapshot on.
async function refreshPRs(withAlerts) {
  try {
    const d = await fetchPRs();
    if (withAlerts) {
      const prev = shared("work.snap");
      if (prev) for (const a of alerts(prev, d)) notify({ title: `#${a.p.number} ${a.p.title}`.slice(0, 90), body: `${a.body} · ${a.p.repo}`, level: a.level, action: { name: "work.prs" } });
      setShared("work.snap", snapshot(d));
    }
    setShared("work.prs", d);
  } catch (e) {
    setShared("work.prs", { open: [], merged: [], ...(shared("work.prs") ?? {}), error: String(e.message ?? e).slice(0, 300) });
  }
}

const THREADS_QUERY = `query($o: String!, $n: String!, $num: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $num) {
  reviewThreads(first: 100) { nodes { isResolved path line originalLine comments(first: 20) { nodes { author { login } body } } } } } } }`;

export function threadsMessage(p, threads) {
  const lines = threads.filter((t) => !t.isResolved).map((t) => {
    const [first, ...replies] = t.comments.nodes, line = t.line ?? t.originalLine;
    return [`- ${t.path}${line ? `:${line}` : ""} @${first?.author?.login ?? "?"}: ${first?.body?.trim() ?? ""}`,
      ...replies.map((c) => `  - @${c.author?.login ?? "?"}: ${c.body.trim()}`)].join("\n");
  });
  return [`Unresolved review comments on PR #${p.number} (${p.url}):`, ...lines].join("\n");
}
if (threadsMessage({ number: 7, url: "U" }, [{ isResolved: false, path: "a.py", line: 3, comments: { nodes: [{ author: { login: "x" }, body: "why? " }, { author: { login: "me" }, body: "ok" }] } }, { isResolved: true, path: "b", comments: { nodes: [] } }])
  !== "Unresolved review comments on PR #7 (U):\n- a.py:3 @x: why?\n  - @me: ok") throw new Error("threadsMessage self-check failed");

// ---- Linear

const ISSUES_QUERY = `query { viewer { assignedIssues(first: 100, orderBy: updatedAt, filter: { state: { type: { in: ["started", "unstarted"] } } }) {
  nodes { identifier title url branchName state { name type } project { name url } team { key } } } } }`;
// The key stays in Keychain and reaches curl through its stdin, never on a command line.
const LINEAR_SH = `key=$(security find-generic-password -s herdr-linear -w 2>/dev/null) || exit 3
printf 'header = "Authorization: %s"\\n' "$key" | curl -sS --max-time 20 -K - -H 'Content-Type: application/json' --data "$1" https://api.linear.app/graphql`;

async function refreshIssues() {
  try {
    const r = await exec("sh", ["-c", LINEAR_SH, "sh", JSON.stringify({ query: ISSUES_QUERY })]);
    if (r.code === 3) { setShared("work.issues", { at: Date.now(), nokey: true, issues: [] }); return; }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    const d = JSON.parse(r.stdout);
    if (d.errors) throw new Error(d.errors[0].message);
    setShared("work.issues", { at: Date.now(), issues: d.data.viewer.assignedIssues.nodes });
  } catch (e) {
    setShared("work.issues", { issues: [], ...(shared("work.issues") ?? {}), error: String(e.message ?? e).slice(0, 300) });
  }
}

async function openLinear(url) {
  const r = await exec("open", ["-a", "Linear", url]).catch(() => null);
  if (r?.code !== 0) await exec("open", [url]);
}

// ---- Sessions

// The terminal pane on a matching branch (agents first), with its tab and space.
function sessionWhere(match) {
  const p = panes().filter((x) => x.terminal && x.branch && match(x.branch)).sort((a, b) => Boolean(b.status) - Boolean(a.status))[0];
  if (!p) return null;
  for (const s of spaces()) { const tab = s.tabs.find((t) => t.id === p.tab); if (tab) return { pane: p, tab, space: s }; }
  return null;
}
function goTo(s) { run("space.select", { id: s.space.id }); run("tab.select", { id: s.tab.id }); run("pane.focus", { pane: s.pane.pane }); }
const sessionName = (s) => (s.tab.named ? s.tab.name : s.pane.program?.name ?? s.pane.terminal);

// branch -> worktree folder (the main checkout included).
async function worktrees(repo) {
  const r = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  const out = {};
  let path = null;
  for (const l of r.stdout.split("\n")) {
    if (l.startsWith("worktree ")) path = l.slice(9);
    else if (l.startsWith("branch refs/heads/")) out[l.slice(18)] = path;
  }
  return out;
}

// A Claude tab on `branch`: in its worktree when one exists (any branch with the same issue key counts), resuming the
// folder's last conversation; else a new worktree first, from origin/main for a new branch or origin's copy of a PR's.
// shortcut: `claude -c` with no earlier conversation there exits; start `claude` by hand then.
async function openSession({ repo, branch, fresh, key, task, space, name }) {
  try {
    const trees = await worktrees(repo);
    const hit = trees[branch] ? branch : key ? Object.keys(trees).find((b) => issueKey(b) === key && trees[b] !== repo) : null;
    if (hit) { run("tab.new", { space, name, folder: trees[hit], argv: ["claude", "-c"] }); return; }
    const dir = `${repo}/.worktrees/${branch.replace(/^[^/]+\//, "").replace(/\//g, "-")}`;
    // Repos default to main or dev: start from origin's default branch.
    const def = fresh ? (await exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "origin/HEAD"])).stdout.trim() || "origin/main" : null;
    const steps = fresh ? [["fetch", "origin", def.slice(7)], ["worktree", "add", "--no-track", "-b", branch, dir, def]] : [["fetch", "origin", branch], ["worktree", "add", dir, branch]];
    for (const args of steps) {
      const r = await exec("git", ["-C", repo, ...args], { timeout: 120000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    }
    run("tab.new", { space, name, folder: dir, argv: ["claude"], ...(task ? { task } : {}) });
  } catch (e) {
    notify({ title: `Couldn't open ${branch}`, body: String(e.message ?? e).slice(0, 300), level: "error" });
  }
}

const slug = (url) => /\/project\/([^/?#]+)/.exec(url ?? "")?.[1] ?? null;
// The space linked to that Linear project (cmd-l's links), else the current one.
function spaceFor(projectUrl) {
  const want = slug(projectUrl);
  const hit = want && Object.entries(shared("linear.projects") ?? {}).find(([id, u]) => slug(u) === want && spaces().some((s) => s.id === id));
  return hit ? hit[0] : activeSpace();
}

// In a space linked to a Linear project (cmd-l's link), only that project's issues; elsewhere all of yours.
function visibleIssues(data) {
  const want = slug((shared("linear.projects") ?? {})[activeSpace()]), all = data?.issues ?? [];
  return { want, issues: want ? all.filter((i) => slug(i.project?.url) === want) : all };
}

function startIssue(issue) {
  const repo = (shared("work.repos") ?? {})[issue.team.key];
  if (!repo) { pickRepo(issue.team.key, issue); return; }
  const words = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 4).join("-");
  openSession({
    repo, fresh: true, key: issue.identifier, branch: `${BRANCH_PREFIX}${issue.identifier.toLowerCase()}${words ? `-${words}` : ""}`,
    task: `Work on ${issue.identifier}: ${issue.title}\n${issue.url}`, space: spaceFor(issue.project?.url), name: `${issue.identifier} ${issue.title}`.slice(0, 40),
  });
}

function pickRepo(team, issue = null) {
  openOverlay({ mod: "work", kind: "dialog", width: 420, height: 440, props: { pick: { team, issue } } });
}

const openPR = (p) => openSession({ repo: `${REPOS()}/${p.repo}`, branch: p.branch, fresh: false, space: activeSpace(), name: `#${p.number} ${p.title}`.slice(0, 40) });

async function sendComments(p, s) {
  try {
    const [o, n] = p.owner.split("/");
    const r = await exec("gh", ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `o=${o}`, "-f", `n=${n}`, "-F", `num=${p.number}`]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    const threads = JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads.nodes;
    // A blocked agent refuses it (hc send without --force).
    const sent = await hc(["send", s.pane.terminal, threadsMessage(p, threads)]);
    if (sent.code !== 0) throw new Error((sent.stderr || sent.stdout).trim());
    goTo(s);
  } catch (e) {
    notify({ title: `Couldn't send #${p.number}'s comments`, body: String(e.message ?? e).slice(0, 300), level: "error" });
  }
}

// After a merge: closes the tabs working in the worktree, removes it and deletes the branch. Refuses on uncommitted
// changes, on local commits the merged PR doesn't have, and when a tab to close is its space's last (spaces close by hand).
async function cleanup(p, dir) {
  const repo = `${REPOS()}/${p.repo}`, git = (args, cwd = dir) => exec("git", ["-C", cwd, ...args], { timeout: 120000 });
  try {
    if ((await git(["status", "--porcelain"])).stdout.trim()) throw new Error(`Uncommitted changes in ${dir}`);
    await git(["fetch", "origin", `pull/${p.number}/head`], repo);
    const tip = (await git(["rev-parse", "HEAD"])).stdout.trim();
    if (tip !== p.head && (await git(["merge-base", "--is-ancestor", "HEAD", p.head])).code !== 0) throw new Error("The local branch has commits the merged PR doesn't have");
    const tabIds = [...new Set(panes().filter((x) => x.cwd === dir || x.cwd?.startsWith(`${dir}/`)).map((x) => x.tab))];
    for (const s of spaces()) {
      const mine = s.tabs.filter((t) => tabIds.includes(t.id));
      if (mine.length && mine.length >= s.tabs.length) throw new Error(`Its session is the last tab in "${s.name}": close that by hand first`);
    }
    for (const id of tabIds) run("tab.close", { id, confirmed: true });
    const rm = await git(["worktree", "remove", dir], repo);
    if (rm.code !== 0) throw new Error((rm.stderr || rm.stdout).trim());
    await git(["branch", "-D", p.branch], repo);
    notify({ title: `Cleaned up #${p.number}`, body: `Removed ${dir.replace(home(), "~")} and ${p.branch}`, level: "info" });
  } catch (e) {
    notify({ title: `Didn't clean up #${p.number}`, body: String(e.message ?? e).slice(0, 300), level: "warning" });
  }
}

// ---- Panes

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}
// cmd-shift-i / cmd-shift-l: show that pane in the right panel; again (while it shows): hide the panel.
function togglePane(view) {
  const panel = find(layout(), "panel"), stack = find(layout(), "panel-body");
  if (panel && !panel.hidden && stack?.active === view) { run("layout.hide", { id: "panel" }); return; }
  run("layout.select", { stack: "panel-body", child: view });
  run("layout.show", { id: "panel" });
}

export default class Work extends View {
  init(_props, cx) {
    this.view = props()?.view ?? null;
    this.trees = {}; this.busy = {};
    if (props()?.pick) {
      this.repoList = null;
      cx.spawn(async (cx) => {
        const r = await exec("sh", ["-c", 'for d in "$1"/*/; do [ -e "$d.git" ] && printf "%s\\n" "${d%/}"; done', "sh", REPOS()]).catch(() => null);
        this.repoList = (r?.stdout ?? "").split("\n").filter(Boolean);
        cx.notify();
      });
      return;
    }
    if (this.view !== "badge") return;
    cx.spawn(async () => { await refreshPRs(true); await refreshIssues(); });
    cx.timer.every(120000, () => { refreshPRs(true); });
    cx.timer.every(300000, () => { refreshIssues(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = (await nextCommand()).split(/[.:]/).pop();
        if (command === "prs" || command === "linear") togglePane(command);
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    if (props()?.pick) return this.renderPick(t);
    if (this.view === "badge") return this.renderBadge(t);
    const root = v_flex().id(`work-${this.view}`).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    return this.view === "linear" ? this.renderLinear(root, t, cx) : this.renderPRs(root, t, cx);
  }

  chip(t, id, label, color, onClick) {
    return div().id(id).flex_none().px(5).h(18).flex().items_center().rounded(4).text_size(11).text_color(color ?? t.muted)
      .when(Boolean(onClick), (e) => e.cursor_pointer().border_1().border_color(t.border).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(label);
  }

  header(t, title, data, refresh, key) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(title))
      .child(div().flex_1().text_size(11).text_color(t.dim).child(data?.at ? `updated ${ago(data.at)}` : ""))
      .child(this.chip(t, `refresh-${key}`, this.busy[key] ? "…" : "Refresh", null, (cx) => {
        if (this.busy[key]) return;
        this.busy[key] = true; cx.notify();
        cx.spawn(async (cx) => { await refresh(); this.busy[key] = false; cx.notify(); });
      }));
  }

  list(id, children) {
    return div().flex_1().min_h(0).child(v_flex().id(id).size_full().overflow_y_scrollbar().p(6).gap(2).children(children));
  }

  section(t, label) {
    return div().px(8).pt(10).pb(4).text_size(11).font_semibold().text_color(t.dim).child(label);
  }

  // ---- PR pane

  ciMark(t, ci) {
    if (!ci) return div().w(14).flex_none();
    const [mark, color] = ci === "SUCCESS" ? ["✓", C.green] : FAILED.has(ci) ? ["✗", C.red] : ["•", C.amber];
    return div().w(14).flex_none().text_color(color).font_bold().child(mark);
  }

  // Merged PRs' worktrees, looked up again whenever the PR list changes.
  loadTrees(data, cx) {
    if (!data?.at || this.treesAt === data.at) return;
    this.treesAt = data.at;
    cx.spawn(async (cx) => {
      const trees = {};
      for (const repo of new Set(data.merged.map((p) => p.repo))) trees[repo] = await worktrees(`${REPOS()}/${repo}`).catch(() => ({}));
      this.trees = trees;
      cx.notify();
    });
  }

  prRow(t, p, merged) {
    const s = sessionWhere((b) => b === p.branch), dir = merged ? this.trees[p.repo]?.[p.branch] : null;
    const review = p.review === "APPROVED" ? ["approved", C.green] : p.review === "CHANGES_REQUESTED" ? ["changes requested", C.red] : null;
    return v_flex().id(`pr-${p.url}`).flex_none().px(8).py(6).gap(3).rounded(7).cursor_pointer().hover((e) => e.bg(t.hover))
      .on_click(() => { exec("open", [p.url]).catch(() => null); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(merged ? div().w(14).flex_none().text_color(C.blue).child("⇣") : this.ciMark(t, p.ci))
        .child(div().flex_none().text_color(t.dim).text_size(12).child(`#${p.number}`))
        .child(div().flex_1().min_w(0).truncate().child(p.title)))
      .child(h_flex().pl(20).gap(5).items_center().min_w(0).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${p.repo} · ${p.branch.replace(/^[^/]+\//, "")}`))
        .when(p.draft, (e) => e.child(this.chip(t, `draft-${p.url}`, "draft")))
        .when(Boolean(review) && !merged, (e) => e.child(this.chip(t, `rv-${p.url}`, review[0], review[1])))
        .when(p.unresolved > 0 && !merged, (e) => e.child(s
          ? this.chip(t, `send-${p.url}`, `Send ${p.unresolved} comment${p.unresolved === 1 ? "" : "s"}`, C.amber, () => sendComments(p, s))
          : this.chip(t, `un-${p.url}`, `${p.unresolved} unresolved`, C.amber)))
        .when(Boolean(s), (e) => e.child(this.chip(t, `go-${p.url}`, `→ ${sessionName(s)}`.slice(0, 28), t.foreground, () => goTo(s))))
        .when(!s && !merged, (e) => e.child(this.chip(t, `open-${p.url}`, "Open", null, () => openPR(p))))
        .when(Boolean(dir), (e) => e.child(this.chip(t, `clean-${p.url}`, "Clean up", null, () => cleanup(p, dir)))));
  }

  renderPRs(root, t, cx) {
    const data = shared("work.prs");
    this.loadTrees(data, cx);
    // Needing you first: CI failed, changes requested, unresolved comments; then the most recently updated.
    const need = (p) => (FAILED.has(p.ci) ? 4 : 0) + (p.review === "CHANGES_REQUESTED" ? 2 : 0) + (p.unresolved > 0 ? 1 : 0);
    const open = [...(data?.open ?? [])].sort((a, b) => need(b) - need(a) || (b.updated ?? "").localeCompare(a.updated ?? ""));
    const merged = data?.merged ?? [];
    return root
      .child(this.header(t, "Pull requests", data, () => refreshPRs(false), "prs"))
      .when(Boolean(data?.error), (e) => e.child(div().px(12).py(6).text_size(11).text_color(C.red).child(data.error)))
      .child(this.list("work-prs", [
        ...(!data ? [div().p(8).text_color(t.dim).child("Loading…")] : []),
        ...(data ? [this.section(t, `Open · ${open.length}`)] : []),
        ...open.map((p) => this.prRow(t, p, false)),
        ...(merged.length ? [this.section(t, `Merged · last 7 days · ${merged.length}`)] : []),
        ...merged.map((p) => this.prRow(t, p, true)),
      ]));
  }

  // ---- Linear pane

  issueRow(t, i) {
    const s = sessionWhere((b) => issueKey(b) === i.identifier), started = i.state.type === "started";
    return v_flex().id(`is-${i.identifier}`).flex_none().px(8).py(6).gap(3).rounded(7).cursor_pointer().hover((e) => e.bg(t.hover))
      .on_click(() => { openLinear(i.url); })
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(div().size(8).mx(3).flex_none().rounded(4).when(started, (e) => e.bg(C.amber)).when(!started, (e) => e.border(1.5).border_color(t.dim)))
        .child(div().flex_none().text_color(t.dim).text_size(12).child(i.identifier))
        .child(div().flex_1().min_w(0).truncate().child(i.title)))
      .child(h_flex().pl(20).gap(5).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(i.state.name))
        .when(Boolean(s), (e) => e.child(this.chip(t, `go-${i.identifier}`, `→ ${sessionName(s)}`.slice(0, 28), t.foreground, () => goTo(s))))
        .when(!s, (e) => e.child(this.chip(t, `start-${i.identifier}`, "Start", null, () => startIssue(i)))));
  }

  renderLinear(root, t) {
    const data = shared("work.issues"), repos = shared("work.repos") ?? {}, { want, issues } = visibleIssues(data);
    const groups = new Map();
    for (const i of issues) {
      const k = i.project?.name ?? "No project";
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a === "No project") - (b === "No project") || a.localeCompare(b));
    const teams = [...new Set(issues.map((i) => i.team.key))].sort();
    const title = want ? `Linear · ${issues[0]?.project?.name ?? spaces().find((s) => s.active)?.name ?? "this project"}` : "Linear";
    const noKey = v_flex().p(10).gap(8).text_size(12).text_color(t.muted)
      .child(div().child("Add a Linear API key: in Linear, Settings → Security & access → Personal API keys → New key. Then run this in a terminal and paste the key:"))
      .child(div().p(8).rounded(6).bg(t.raised).font_family("JetBrains Mono").text_size(11).text_color(t.foreground).child("security add-generic-password -s herdr-linear -a linear -w"))
      .child(div().child("Then press Refresh."));
    return root
      .child(this.header(t, title, data, () => refreshIssues(), "linear"))
      .when(Boolean(data?.error), (e) => e.child(div().px(12).py(6).text_size(11).text_color(C.red).child(data.error)))
      .child(data?.nokey ? noKey : this.list("work-linear", [
        ...(!data ? [div().p(8).text_color(t.dim).child("Loading…")] : []),
        ...(data && !data.nokey && !issues.length ? [div().p(8).text_color(t.dim).child(want ? "None of your open issues are in this project." : "No open issues assigned to you.")] : []),
        ...ordered.flatMap(([name, list]) => [this.section(t, `${name} · ${list.length}`), ...[...list].sort((a, b) => (b.state.type === "started") - (a.state.type === "started")).map((i) => this.issueRow(t, i))]),
      ]))
      .when(teams.length > 0, (e) => e.child(v_flex().flex_none().px(14).py(8).gap(3).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .children(teams.map((k) => h_flex().gap(6).items_center()
          .child(div().child(`${k} starts in ${repos[k] ? repos[k].split("/").pop() : "—"}`))
          .child(this.chip(t, `repo-${k}`, repos[k] ? "change" : "pick", null, () => pickRepo(k)))))));
  }

  // ---- Repo dialog

  renderPick(t) {
    const { team, issue } = props().pick;
    return v_flex().size_full().bg(t.popover ?? t.background).text_color(t.foreground).text_size(13).p(14).gap(8)
      .child(div().font_semibold().child(`Repo for ${team} issues`))
      .child(div().text_size(11).text_color(t.dim).child(issue ? `Remembered for the next ${team} issue. Starting ${issue.identifier} after this.` : "Remembered for every issue of this team."))
      .child(div().flex_1().min_h(0).child(v_flex().id("pick-list").size_full().overflow_y_scrollbar().gap(1)
        .when(!this.repoList, (e) => e.child(div().text_color(t.dim).child("Loading…")))
        .children((this.repoList ?? []).map((dir) => div().id(`pick-${dir}`).flex_none().px(8).py(5).rounded(6).cursor_pointer().hover((e) => e.bg(t.hover))
          .on_click(() => {
            setShared("work.repos", { ...(shared("work.repos") ?? {}), [team]: dir });
            closeOverlay(props().overlay);
            if (issue) startIssue(issue);
          })
          .child(dir.split("/").pop())))));
  }

  // ---- Status bar badge

  renderBadge(t) {
    const prs = shared("work.prs"), iss = shared("work.issues"), open = prs?.open ?? [];
    const failing = open.filter((p) => FAILED.has(p.ci)).length, changes = open.filter((p) => p.review === "CHANGES_REQUESTED").length;
    const comments = open.filter((p) => p.unresolved > 0).length;
    const part = (id, onClick) => h_flex().id(id).gap(6).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(onClick);
    return h_flex().size_full().px(10).gap(14).items_center().justify_end().text_size(11).text_color(t.dim)
      .child(part("badge-prs", () => togglePane("prs")).tooltip("Pull requests (⌘⇧I)")
        .child(div().child(prs ? `${open.length} PRs` : "PRs …"))
        .when(failing > 0, (e) => e.child(div().text_color(C.red).child(`✗ ${failing}`)))
        .when(changes > 0, (e) => e.child(div().text_color(C.red).child(`${changes} changes`)))
        .when(comments > 0, (e) => e.child(div().text_color(C.amber).child(`${comments} with comments`)))
        .when(Boolean(prs?.error), (e) => e.child(div().text_color(C.red).child("!"))))
      .child(part("badge-linear", () => togglePane("linear")).tooltip("Linear (⌘⇧L)")
        .child(div().child(iss?.nokey ? "Linear: add a key" : iss ? `${visibleIssues(iss).issues.length} issues` : "Linear …"))
        .when(Boolean(iss?.error), (e) => e.child(div().text_color(C.red).child("!"))));
  }
}
