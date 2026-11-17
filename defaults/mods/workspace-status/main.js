// Modified by Kestrel Contributors (2026) from upstream Herdr (herdr-app, Apache-2.0). See NOTICE.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, agents, theme, run, window, keys, shared, exec, home, layout } from "herdr";

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.gitDiff = null;
    this.lastCwd = null;
    if (home() !== "/fixture") {
      this.refreshDiff(cx);
      cx.timer.every(5000, (cx) => this.refreshDiff(cx));
    }
  }

  refreshDiff(cx) {
    if (home() === "/fixture") return;
    const space = spaces().find((s) => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const cwd = pane?.cwd || f?.cwd || space?.folder;
    const on = space?.machine ?? null;
    this.lastCwd = cwd;
    if (!cwd) {
      this.gitDiff = null;
      return;
    }
    cx.spawn(async (cx) => {
      try {
        const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], { cwd, on });
        if (st.code !== 0) {
          this.gitDiff = null;
        } else {
          const files = (st.stdout || "").split("\n").filter((l) => l.trim().length > 0).length;
          let added = 0;
          let removed = 0;
          if (files > 0) {
            const num = await exec("git", ["--no-optional-locks", "diff", "--numstat", "HEAD"], { cwd, on });
            if (num.code === 0 && num.stdout) {
              for (const line of num.stdout.split("\n")) {
                const [a, d] = line.split("\t");
                if (Number.isFinite(Number(a))) added += Number(a);
                if (Number.isFinite(Number(d))) removed += Number(d);
              }
            }
          }
          this.gitDiff = { files, added, removed };
        }
      } catch {
        this.gitDiff = null;
      }
      cx.notify();
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(s => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    const cwd = pane?.cwd || f?.cwd || space?.folder;
    if (home() !== "/fixture" && cwd !== this.lastCwd) {
      this.refreshDiff(cx);
    }
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const vx = { enabled: false, project: "", location: "global", model: "", ...(shared("vertex") ?? {}) };
    const vxText = vx.enabled
      ? `Vertex AI: ${vx.project || "configured"} (${vx.location || "global"})${vx.model ? ` · ${vx.model}` : ""}`
      : "Vertex AI: off";
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .when(Boolean(this.gitDiff && this.gitDiff.files > 0), el =>
        el.child(
          h_flex()
            .id("git-diff-badge")
            .gap(5)
            .px(6)
            .py(1)
            .rounded(4)
            .bg(t.raised)
            .items_center()
            .cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => {
              const L = layout();
              const panel = findNode(L, "panel");
              const body = findNode(L, "panel-body");
              if (panel && !panel.hidden && body?.active === "changes") {
                run("layout.hide", { id: "panel" });
              } else {
                run("layout.select", { stack: "panel-body", child: "changes" });
                run("layout.show", { id: "panel" });
              }
            })
            .child(div().text_color(t.foreground).child(`${this.gitDiff.files} changed`))
            .when(this.gitDiff.added > 0 || this.gitDiff.removed > 0, sub =>
              sub.child(div().text_color(t.done).child(`+${this.gitDiff.added}`)).child(div().text_color(t.blocked).child(`-${this.gitDiff.removed}`)),
            ),
        ),
      )
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(
        h_flex()
          .id("vertex-status")
          .gap(6)
          .px(7)
          .py(2)
          .rounded(5)
          .items_center()
          .cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("app.settings", { section: "vertex" }))
          .child(div().size(6).rounded(3).bg(vx.enabled ? t.accent : t.dim))
          .child(vxText),
      )
      .child(
        div()
          .id("launch-agy")
          .px(7)
          .py(2)
          .rounded(5)
          .text_color(t.foreground)
          .bg(t.raised)
          .hover(s => s.bg(t.selected))
          .cursor_pointer()
          .on_click(() => {
            const argv = vx.model?.trim() ? ["agy", "--model", vx.model.trim()] : ["agy"];
            run("tab.new", { name: "Antigravity", space: space?.id, argv });
          })
          .child("+ agy"),
      )
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
