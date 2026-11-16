// Opens the Changes panel the first time an agent works in a space, once per
// space, so closing it sticks. Draws nothing: an empty floating block in
// layouts/mine.json, there only to stay alive (a hidden panel's mod never starts).

import { View, div } from "gpui-kit";
import { agents, spaces, layout, run, shared, setShared } from "herdr";

// The tab bar restores each space's remembered panel for about a second after a switch.
const SETTLE = 1500;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class AutoChanges extends View {
  render(cx) {
    const space = spaces().find((s) => s.active);
    if (!space?.branch) return div(); // not in a repo: nothing to show
    if (space.id !== this.space) { this.space = space.id; this.since = Date.now(); }
    const opened = shared("auto-changes.opened") ?? [];
    if (opened.includes(space.id) || !agents().some((a) => a.space === space.id && a.status === "working")) return div();
    const wait = this.since + SETTLE - Date.now();
    if (wait > 0) {
      cx.timer.after(wait + 50, (cx) => cx.notify());
      return div();
    }
    const root = layout(), panel = find(root, "panel");
    if (panel?.hidden) {
      run("layout.select", { stack: "panel-body", child: "changes" });
      run("layout.show", { id: "panel" });
    }
    const live = new Set(spaces().map((s) => s.id));
    setShared("auto-changes.opened", [...opened.filter((id) => live.has(id)), space.id]);
    return div();
  }
}
