// Review a branch by name (cmd-g): finds its repo (its PR on GitHub, else a local
// clone that has it on origin), checks it out in a worktree (or reuses one), opens a
// Claude tab there and has it review the PR with the ponytail-review skill.
// A pasted folder path (a worktree) gets its uncommitted changes reviewed instead.

import { View, div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, exec, home, setShared } from "herdr";

const REPOS_DIR = "cooper-square-technologies"; // under home, named like their GitHub repos
const OWNER = "cooper-square-technologies";

async function git(repo, args, timeout) {
  const r = await exec("git", ["-C", repo, ...args], { ...(timeout ? { timeout } : {}) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The local clone that has `branch` and its PR ({ repo, pr: { number, url } | null }): the PR's repo,
// else the first clone with origin/<branch>.
async function findRepo(branch) {
  const root = `${home()}/${REPOS_DIR}`;
  const r = await exec("gh", ["search", "prs", "--head", branch, "--owner", OWNER, "--json", "repository,number,url", "--limit", "1"]).catch(() => null);
  const pr = r?.code === 0 ? JSON.parse(r.stdout)[0] : null;
  if (pr) return { repo: `${root}/${pr.repository.name}`, pr };
  const list = await exec("sh", ["-c", 'for d in "$1"/*/; do [ -e "$d.git" ] && printf "%s\\n" "${d%/}"; done', "sh", root]);
  for (const repo of (list.stdout ?? "").split("\n").filter(Boolean)) {
    if ((await git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).ok) return { repo, pr: null };
  }
  return null;
}

// The folder `branch` is checked out in: an existing checkout, else a new worktree.
async function checkout(repo, branch) {
  const list = await git(repo, ["worktree", "list", "--porcelain"]);
  let path = null;
  for (const l of list.out.split("\n")) {
    if (l.startsWith("worktree ")) path = l.slice(9);
    else if (l === `branch refs/heads/${branch}`) return path;
  }
  const fetched = await git(repo, ["fetch", "origin", branch], 120000);
  if (!fetched.ok) throw new Error(fetched.err || `Couldn't fetch ${branch}`);
  const dir = `${repo}/.worktrees/${branch.replace(/^[^/]+\//, "").replace(/\//g, "-")}`;
  const add = await git(repo, ["worktree", "add", dir, branch], 120000);
  if (!add.ok) throw new Error(add.err || "git worktree add failed");
  return dir;
}

export default class ReviewBranch extends View {
  init(_props, cx) {
    this.input = InputState.new({ placeholder: "Branch, or a worktree folder for its uncommitted changes" });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.input.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  go(cx) {
    const text = this.input.value().trim().replace(/^['"]|['"]$/g, "");
    if (!text || this.busy) return;
    const folder = text.startsWith("~") ? home() + text.slice(1) : text.startsWith("/") ? text : null;
    const branch = text.replace(/^origin\//, "");
    this.busy = folder ? "Reading the folder…" : "Finding the repo…"; this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let dir, task;
        if (folder) {
          const top = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"]).catch(() => null);
          if (top?.code !== 0) throw new Error(`${text} is not a git checkout.`);
          dir = top.stdout.trim();
          task = "Use the ponytail-review skill to review the uncommitted changes in this worktree (staged, unstaged and untracked). Read-only: report findings, change no code.";
        } else {
          const found = await findRepo(branch);
          if (!found) throw new Error(`No repo in ~/${REPOS_DIR} has ${branch} on origin.`);
          this.busy = `Checking out in ${found.repo.split("/").pop()}…`; cx.notify();
          dir = await checkout(found.repo, branch);
          const what = found.pr ? `PR #${found.pr.number} (${found.pr.url})` : `branch ${branch}`;
          task = `Use the ponytail-review skill to review ${what}: everything on this branch since it left its base branch${found.pr ? " (the PR's base)" : " (origin/HEAD)"}. Run git pull first if the branch is behind origin. Read-only: report findings, change no code.`;
        }
        // Review's mode is shared by every review: a folder shows its uncommitted work, a branch the whole branch (for cmd-shift-g later).
        setShared("review.mode", folder ? "uncommitted" : "branch");
        const label = folder ? dir.split("/").pop() : branch.replace(/^[^/]+\//, "");
        run("tab.new", { space: spaces().find((s) => s.active)?.id, name: `Review ${label}`.slice(0, 40), folder: dir, argv: ["claude"], task });
        closeOverlay(props().overlay);
      } catch (e) {
        this.busy = null; this.error = String(e.message ?? e).slice(0, 300);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    return v_flex().id("review-branch").size_full().p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((e) => { if (e.key === "escape") closeOverlay(props().overlay); })
      .child(div().font_semibold().text_size(15).child("Review a branch"))
      .child(Input.new(this.input).h(34).px(10).items_center().rounded(8).border(1).border_color(t.accent).bg(t.background))
      .child(div().text_size(11.5).text_color(this.error ? t.blocked : t.dim)
        .child(this.error || this.busy || "Enter starts a Claude review · a branch: its PR · a folder path: its uncommitted changes · Esc closes"));
  }
}
