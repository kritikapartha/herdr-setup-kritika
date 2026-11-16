# Herdr setup

A Herdr window for working with coding agents:
- **Spaces** are projects. Each space can link to a Linear project.
- **Tabs** are agent sessions.
- **Review** shows a branch's diff. You comment on lines and send the comments to the agent.
- **PR and Linear panes** list your PRs and issues, each tied to the session that works on it.

## What's in it

| Path | What |
|---|---|
| `layouts/my-main.json` | The window: the stock `main` layout, plus the panes and the status bar badge below |
| `mods/my-spaces` | Spaces list. A space can link to a Linear project; `cmd-l` opens it in the Linear app |
| `mods/my-agents` | Agents list. Each row shows its repo, branch, Linear issue and PR (with CI and review state). Sub-agents can open beside the focused pane |
| `mods/review` | The right sidebar lists changed files. The review tab shows every file's diff in one scroll, with line comments sent to the agent |
| `mods/work` | The PR pane (newest update first), the Linear pane and the status bar badge. The badge polls GitHub and Linear and posts PR alerts |
| `mods/repos` | `cmd-o`: pick a repo and open it in a space with a Claude tab |
| `mods/task` | `cmd-shift-n`: start a task in a new worktree off the repo's default branch, with an agent |
| `mods/pr-changes` | A Changes panel with the current PR's diff. It follows the agent's edits live, and a chip row switches between worktrees |
| `mods/auto-changes` | Opens the Changes panel the first time an agent works in a repo space |
| `mods/review-branch` | `cmd-g`: paste a branch (its PR) or a worktree path (its uncommitted changes). A Claude tab opens there and reviews it with `ponytail-review` |
| `keys.json` | Key bindings (see below) |
| `extras/` | Pieces that live outside Herdr's folder (see Install) |

## Install

1. Copy `layouts/my-main.json` and the `mods/` folders into `~/.config/herdr-app/`.
   Merge `keys.json` into yours: add its keys and sections, and don't overwrite keys you already use.
   Then run `herdr-app do layout.switch --name my-main`.
2. Change the settings to yours:
   - `mods/work/main.js` top: `REPOS_DIR` and `BRANCH_PREFIX`.
   - `mods/repos/main.js`: `ROOT`. `mods/review-branch/main.js`: `REPOS_DIR` and `OWNER`.
   - `mods/my-agents/main.js`: `LINEAR`, the Linear workspace URL.
3. Linear: create a personal API key (Linear → Settings → Security & access).
   Run `security add-generic-password -s herdr-linear -a linear -w` and paste the key.
   The key stays in Keychain.
4. Optional extras:
   - `extras/herdr-core-templates/*.md` → `~/.config/herdr-core/templates/`.
     These are the two PR reviewers. They need the `ponytail-review` and `thermo-nuclear-code-quality-review` Claude skills.
   - `extras/CLAUDE.md` → append to `~/.claude/CLAUDE.md`. It tells agents how to use sub-agents and the reviewers.
   - If your tools come from mise, add `eval "$(mise activate zsh --shims)"` to `~/.zprofile`.
     Without it, Claude hooks fail with `node: command not found` in agents started by `hc`.
     It takes effect after `hc server stop && hc server start`, which ends running agents.

Or tell your Claude: "add the Herdr setup from this repo".

## Keys

| Key | Action |
|---|---|
| `cmd-b` / `cmd-shift-b` | Left / right sidebar |
| `cmd-1..9`, `ctrl-1..9` | Tabs, spaces |
| `ctrl-tab` / `ctrl-shift-tab` | Next / previous space |
| `cmd-shift-up` / `down` | Previous / next space |
| `cmd-left` / `right` | Pane to the left / right |
| `cmd-r` / `cmd-shift-r` | Rename tab / space |
| `cmd-t`, `cmd-shift-t` | New tab, new Claude tab |
| `cmd-o` | Open a repo |
| `cmd-shift-n` | New task in a worktree |
| `cmd-g` | Review a branch's PR, or a worktree's uncommitted changes, in a Claude tab |
| `cmd-alt-l` | Switch layout |
| `cmd-w`, `cmd-shift-w` | Close the tab / pane. On a sub-agent, it goes back under its parent and keeps running. Never closes a space's last pane |
| `cmd-k` | Clear the terminal |
| `cmd-left` / `right` (in a terminal) | Start / end of the line |
| `cmd-l` | Open the space's Linear project, or link one |
| `cmd-shift-g` | Review tab for the focused terminal |
| `cmd-shift-i` / `cmd-shift-l` | PR pane / Linear pane (again: hide) |
| `cmd-shift-s` | Open the focused agent's newest sub-agent to the right |

In the review tab, click the diff first so these keys reach it:

| Key | Action |
|---|---|
| `cmd-shift-c` | Comment on the selected line or lines (click a line, shift-click for a range, double-click to comment) |
| `cmd-enter` | Send all comments to the agent |
| `cmd-e` | Mark the top file viewed |
| `cmd-shift-e` | Show only this file (again: show all) |

## What it runs

- `git`: diffs, worktrees and cleanup.
- `gh`: your PRs, review threads and PR links. `gh` must be logged in.
- `curl`: Linear's API, with the key read from Keychain.
- `hc send`: comments to agents.

Nothing runs on a timer except two polls, from the badge only: GitHub every 2 minutes and Linear every 5.
