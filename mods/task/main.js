// New task (cmd-shift-n): opens the `repos` dialog on its task step for the
// focused space's repo. mod.open can't pass props, so this hands over and closes.

import { View, div } from "gpui-kit";
import { props, openOverlay, closeOverlay } from "herdr";

export default class Task extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      openOverlay({ mod: "repos", kind: "dialog", width: 560, height: 360, props: { action: "task" } });
      closeOverlay(props().overlay);
    });
  }

  render() {
    return div();
  }
}
