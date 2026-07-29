import * as blessed from "blessed";
import type { IPty } from "node-pty";
import type { TreePanel } from "./tree.js";
import type { OutputPanel } from "./output.js";
import type { StatusBar } from "./status-bar.js";

const ROOT_ID = "adapter";

export function bindKeys(
  screen: blessed.Widgets.Screen,
  tree: TreePanel,
  output: OutputPanel,
  status: StatusBar,
  getPty: () => IPty | null,
  getFocusPanel: () => "tree" | "output",
  setFocusPanel: (panel: "tree" | "output") => void,
  updateBorders: () => void,
  onQuit: () => void,
): void {
  screen.on("keypress", (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
    if (!key || !key.name) return;

    if (key.name === "q") {
      status.updateStatus("Press q again to quit, any other key to cancel");
      screen.render();

      const handler = (_ch: any, key: any) => {
        if (key && key.name === "q") {
          screen.removeListener("keypress", handler);
          onQuit();
          return;
        }
        screen.removeListener("keypress", handler);
        status.updateStatus("Ready");
        screen.render();
      };
      screen.on("keypress", handler);
      return;
    }

    if (getFocusPanel() === "tree") {
      if (key.name === "j" || key.name === "down") {
        tree.getElement().down(1);
        screen.render();
        return;
      }
      if (key.name === "k" || key.name === "up") {
        tree.getElement().up(1);
        screen.render();
        return;
      }
      if (key.name === "enter") {
        const selectedId = tree.getSelectedId();
        if (!selectedId) return;
        if (selectedId === ROOT_ID) {
          setFocusPanel("output");
          output.setLiveMode();
          output.write("-- ORC Live Output --\n");
          updateBorders();
        } else {
          output.showHistory(tree.getOutput(selectedId));
          screen.render();
        }
        return;
      }
      return;
    }

    if (getFocusPanel() === "output") {
      if (key.name === "escape") {
        setFocusPanel("tree");
        output.setLiveMode();
        updateBorders();
        return;
      }
      const pty = getPty();
      if (pty && output.isLiveMode() && tree.isRootSelected()) {
        const seq = key.sequence || _ch || "";
        pty.write(seq);
        if (key.name === "enter") {
          output.append("\n");
        } else if (key.name === "backspace") {
          output.append("\b \b");
        } else if (_ch && _ch.length === 1 && _ch >= " ") {
          output.append(_ch);
        }
      }
      return;
    }
  });
}
