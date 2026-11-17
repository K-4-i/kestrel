// Modified by Kestrel Contributors (2026) from upstream Herdr (herdr-app, Apache-2.0). See NOTICE.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import {
  agents,
  spaces,
  panes,
  run,
  openOverlay,
  closeOverlay,
  nextCommand,
  props,
  theme,
  home,
  window,
  shared,
  layout,
  settings,
} from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function shortFolder(cwd) {
  if (!cwd) return "";
  const h = home();
  const rel = cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
  const parts = rel.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : rel;
}

function tabDisplayInfo(c, allPanes) {
  const tabPanes = allPanes.filter((p) => p.tab === c.id);
  const leadPane = tabPanes.find((p) => p.program?.agent) ?? tabPanes.find((p) => p.focused) ?? tabPanes[0];
  const program = leadPane?.program;
  const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
  return { program, leadPane, name, cwd: leadPane?.cwd, branch: leadPane?.branch };
}

export default class Tabs extends View {
  init(_props, cx) {
    const p = props() || {};
    this.isOverflowPopup = Boolean(p.overflowMenu);
    this.pressed = null;
    this.barWidth = 0;

    if (this.isOverflowPopup) {
      this.query = "";
      this.cursor = 0;
      this.searchFocused = true;
      this.handle = cx.focus_handle();
      this.searchInput = InputState.new({ placeholder: "Jump to tab or running agent…" });
      this.searchInput.on("focus", (_e, cx) => {
        this.searchFocused = true;
        cx.notify();
      });
      this.searchInput.on("blur", (_e, cx) => {
        this.searchFocused = false;
        cx.notify();
      });
      this.searchInput.on("change", (_e, cx) => {
        this.query = this.searchInput.value();
        this.cursor = 0;
        cx.notify();
      });
      this.searchInput.on("submit", () => {
        const { selectable } = this.popupSections();
        const target = selectable[this.cursor] ?? selectable[0];
        if (target) this.activateEntry(target);
      });
      this.searchInput.focus();
      cx.timer.after(80, () => this.searchInput.focus());
      return;
    }

    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.hiddenIds = [];
    if (home() !== "/fixture") {
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "dropdown" || cmd === "overflow") {
            const activeSpace = spaces().find((s) => s.active);
            const shown = activeSpace?.tabs ?? [];
            const otherAgents = agents().filter((a) => a.space && a.space !== activeSpace?.id);
            const totalItems = shown.length + otherAgents.length;
            const popupH = Math.min(450, 96 + Math.max(1, totalItems) * 42 + 48);
            const winW = window()?.width ?? 1280;
            const anchorX = Math.max(280, Math.min(winW - 372, winW - (this.barWidth ? Math.max(280, this.barWidth * 0.34) : 420)));
            openOverlay({
              mod: "tabs",
              kind: "popup",
              width: 356,
              height: popupH,
              at: { x: anchorX, y: 42 },
              props: {
                overflowMenu: true,
                hiddenIds: this.hiddenIds ?? [],
              },
            });
            cx.notify();
          }
        }
      });
    }
  }

  activateEntry(entry) {
    closeOverlay(props().overlay);
    if (entry.kind === "agent") {
      run("agent.focus", { terminal: entry.agent.address });
    } else {
      run("tab.select", { id: entry.tab.id });
    }
  }

  popupSections() {
    const p = props() || {};
    const hiddenSet = new Set(p.hiddenIds ?? []);
    const activeSpace = spaces().find((s) => s.active);
    const allPanes = panes();
    const allAgents = agents();
    const shown = activeSpace?.tabs ?? [];
    const q = (this.query || "").trim().toLowerCase();

    const matchesQuery = (...parts) => !q || parts.filter(Boolean).join(" ").toLowerCase().includes(q);

    const spaceTabEntries = shown
      .map((tab, idx) => {
        const info = tabDisplayInfo(tab, allPanes);
        return {
          kind: "tab",
          tab,
          idx,
          hidden: hiddenSet.has(tab.id),
          ...info,
        };
      })
      .filter((it) => matchesQuery(it.name, it.program?.name, it.cwd, it.branch));

    const hiddenItems = spaceTabEntries.filter((x) => x.hidden);
    const visibleItems = spaceTabEntries.filter((x) => !x.hidden);

    // Also include running agents in OTHER spaces so no running agent is ever hidden!
    const otherAgents = allAgents
      .filter((a) => !activeSpace || a.space !== activeSpace.id)
      .filter((a) => matchesQuery(a.title, a.tab_name, a.space_name, a.program?.name))
      .map((a) => ({
        kind: "agent",
        agent: a,
        program: a.program,
        name: (!/^tb\d+$/.test(a.tab_name || "") && a.tab_name) || a.title || a.program?.name || a.address,
        spaceName: a.space_name || "Space",
        status: a.status,
      }));

    return {
      activeSpace,
      hiddenItems,
      visibleItems,
      otherAgents,
      selectable: [...hiddenItems, ...visibleItems, ...otherAgents],
    };
  }

  renderOverflowPopup() {
    const t = theme();
    const { activeSpace, hiddenItems, visibleItems, otherAgents, selectable } = this.popupSections();
    const stop = (_e, cx) => cx.stop_propagation();

    // Compute exact popup height so kind:"popup" never collapses flex children
    const sectionCount =
      (hiddenItems.length > 0 ? 1 : 0) +
      (visibleItems.length > 0 ? 1 : 0) +
      (otherAgents.length > 0 ? 1 : 0);
    const contentRowsH =
      selectable.length === 0 ? 48 : selectable.length * 40 + sectionCount * 24 + 8;
    const listH = Math.min(380, Math.max(48, contentRowsH));
    const totalPopupH = listH + 64;

    const statusBadge = (status) => {
      if (status === "blocked") {
        return div()
          .px(6)
          .py(1)
          .rounded(4)
          .bg(t.raised)
          .border(1)
          .border_color(t.blocked)
          .text_size(10)
          .font_semibold()
          .text_color(t.blocked)
          .child("Approval");
      }
      if (status === "working") {
        return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
      }
      if (status === "done") {
        return div().size(7).flex_none().rounded_full().bg(t.done);
      }
      return null;
    };

    const renderTabRow = (entry, flatIdx) => {
      const { tab: c, idx, program, name, cwd, branch } = entry;
      const selected = flatIdx === this.cursor;
      const subtitle = [branch ? `⎇ ${branch}` : "", shortFolder(cwd)].filter(Boolean).join(" · ");
      const stNode = statusBadge(c.status);

      return h_flex()
        .id(`ov-tab-${c.id}`)
        .h(38)
        .px(9)
        .gap(8)
        .rounded(7)
        .items_center()
        .flex_none()
        .cursor_pointer()
        .bg(c.active ? t.selected : selected ? t.hover : "#00000000")
        .border(1)
        .border_color(c.active ? t.accent : "#00000000")
        .hover((s) => s.bg(c.active ? t.selected : t.hover))
        .on_click(() => this.activateEntry(entry))
        .child(div().w(18).flex_none().text_size(10.5).text_color(t.dim).child(`#${idx + 1}`))
        .when(Boolean(program?.icon), (el) =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).flex_none().text_color(t.foreground)
              : image(program.icon).size(14).flex_none(),
          ),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(name))
                .when(c.active, (el) =>
                  el.child(
                    div().px(5).py(1).rounded(4).bg(t.raised).text_size(9.5).text_color(t.accent).child("active"),
                  ),
                ),
            )
            .when(Boolean(subtitle), (el) =>
              el.child(div().truncate().text_size(10.2).text_color(t.dim).child(subtitle)),
            ),
        )
        .when(Boolean(stNode), (el) => el.child(stNode))
        .child(
          div()
            .id(`ov-ren-${c.id}`)
            .p(4)
            .rounded(4)
            .text_color(t.dim)
            .hover((s) => s.bg(t.raised).text_color(t.foreground))
            .tooltip("Rename tab")
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              closeOverlay(props().overlay);
              run("tab.rename", { id: c.id });
            })
            .child(svg("mods/workspace-chrome/square-pen.svg").size(11)),
        )
        .child(
          div()
            .id(`ov-cls-${c.id}`)
            .p(4)
            .rounded(4)
            .text_color(t.dim)
            .hover((s) => s.bg(t.raised).text_color(t.ansi1))
            .tooltip("Close tab")
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => {
              cx.stop_propagation();
              run("tab.close", { id: c.id });
              if ((activeSpace?.tabs?.length ?? 0) <= 1) closeOverlay(props().overlay);
            })
            .child(svg("mods/pane/close.svg").size(11)),
        );
    };

    const renderAgentRow = (entry, flatIdx) => {
      const { agent: a, program, name, spaceName, status } = entry;
      const selected = flatIdx === this.cursor;
      const stNode = statusBadge(status);

      return h_flex()
        .id(`ov-ag-${a.address}`)
        .h(38)
        .px(9)
        .gap(8)
        .rounded(7)
        .items_center()
        .flex_none()
        .cursor_pointer()
        .bg(selected ? t.hover : "#00000000")
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.activateEntry(entry))
        .when(Boolean(program?.icon), (el) =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).flex_none().text_color(t.foreground)
              : image(program.icon).size(14).flex_none(),
          ),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(name))
            .child(div().truncate().text_size(10.2).text_color(t.dim).child(`Space: ${spaceName}`)),
        )
        .when(Boolean(stNode), (el) => el.child(stNode));
    };

    const sectionHeader = (label, accent = false) =>
      div()
        .h(22)
        .px(8)
        .pt(4)
        .flex_none()
        .text_size(10.2)
        .font_semibold()
        .text_color(accent ? t.accent : t.dim)
        .child(label);

    let runningIdx = 0;
    return v_flex()
      .id("tabs-overflow-menu")
      .w_full()
      .h(totalPopupH)
      .min_h(0)
      .bg(t.popover)
      .p(8)
      .gap(8)
      .text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          closeOverlay(props().overlay);
          return;
        }
        if (e.key === "down" || e.key === "arrowdown") {
          this.cursor = Math.min(Math.max(0, selectable.length - 1), this.cursor + 1);
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "up" || e.key === "arrowup") {
          this.cursor = Math.max(0, this.cursor - 1);
          cx.stop_propagation();
          cx.notify();
        } else if (e.key === "enter" && selectable[this.cursor]) {
          cx.stop_propagation();
          this.activateEntry(selectable[this.cursor]);
        }
      })
      .child(
        // Clean search bar matching Picker's exact GPUI layout
        h_flex()
          .h(34)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(8)
          .border_1()
          .border_color(this.searchFocused ? t.accent : t.border)
          .bg(t.background)
          .on_mouse_down("left", stop)
          .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.searchInput).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("ov-tabs-scroll")
          .h(listH)
          .min_h(0)
          .gap(2)
          .overflow_y_scrollbar()
          .when(selectable.length === 0, (el) =>
            el.child(div().p(10).text_size(12).text_color(t.dim).child("No matching tabs or running agents.")),
          )
          .when(hiddenItems.length > 0, (el) =>
            el
              .child(sectionHeader(`OVERFLOW TABS (${hiddenItems.length})`, true))
              .children(hiddenItems.map((entry) => renderTabRow(entry, runningIdx++))),
          )
          .when(visibleItems.length > 0, (el) =>
            el
              .child(
                sectionHeader(
                  `${(activeSpace?.name || "CURRENT SPACE").toUpperCase()} (${visibleItems.length})`,
                  false,
                ),
              )
              .children(visibleItems.map((entry) => renderTabRow(entry, runningIdx++))),
          )
          .when(otherAgents.length > 0, (el) =>
            el
              .child(sectionHeader(`OTHER SPACES · RUNNING AGENTS (${otherAgents.length})`, false))
              .children(otherAgents.map((entry) => renderAgentRow(entry, runningIdx++))),
          ),
      );
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null;
        const want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
          } else {
            run("layout.hide", { id: "panel" });
          }
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    if (this.isOverflowPopup) return this.renderOverflowPopup();

    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const allPanes = panes();
    const allAgents = agents();
    const otherSpaceAgents = allAgents.filter((a) => !space || a.space !== space.id);
    const stop = (_e, cx) => cx.stop_propagation();

    const button = (id, label, action, tip = "") =>
      div()
        .id(id)
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(label);

    const root = layout();
    const sidebar = find(root, "sidebar");
    const w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding =
      w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
        ? Math.max(
            10,
            (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0),
          )
        : 10;

    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const rawPanels = shared("workspace.panels");
    const enabled = rawPanels?.length ? rawPanels : ["brain", "board", "files", "changes"];
    this.syncPanel(space, panel, body, enabled);

    // Responsive adaptation based on live measured bar width
    const measuredW = this.barWidth > 0 ? this.barWidth : 980;
    const compactPanels = measuredW < 700;
    const ultraCompact = measuredW < 520;
    const showDropdownBtn = shown.length >= 2 || allAgents.length >= 1;

    const panelButtonW = compactPanels ? 30 : 68;
    const rightControlsW =
      30 + // "+" new tab button
      (showDropdownBtn ? 68 : 0) + // dropdown / overflow trigger reserve
      enabled.length * panelButtonW +
      (w?.buttons ? 86 : 0) +
      20;

    const availTabsW = Math.max(120, measuredW - lightsPadding - rightControlsW);
    const minTabW = ultraCompact ? 92 : measuredW < 760 ? 108 : 120;
    const maxTabW = 192;
    const maxFit = Math.max(1, Math.floor((availTabsW + 3) / (minTabW + 3)));

    // Keep first tabs AND always keep the active tab visible on the bar; put the rest in the dropdown
    let visibleTabs = shown;
    let overflowTabs = [];
    if (shown.length > maxFit) {
      const head = shown.slice(0, maxFit);
      const activeTab = shown.find((c) => c.active);
      if (activeTab && !head.some((c) => c.id === activeTab.id)) {
        head[maxFit - 1] = activeTab;
      }
      const visSet = new Set(head.map((c) => c.id));
      visibleTabs = head;
      overflowTabs = shown.filter((c) => !visSet.has(c.id));
    }

    const tabWidth =
      visibleTabs.length > 0
        ? Math.min(
            maxTabW,
            Math.max(
              minTabW,
              Math.floor((availTabsW - Math.max(0, visibleTabs.length - 1) * 3) / visibleTabs.length),
            ),
          )
        : 140;

    // Surface urgent status from hidden tabs OR agents running in other spaces
    const hiddenStatuses = [...overflowTabs.map((c) => c.status), ...otherSpaceAgents.map((a) => a.status)];
    const urgentBlocked = hiddenStatuses.includes("blocked");
    const urgentWorking = !urgentBlocked && hiddenStatuses.includes("working");
    const urgentDone = !urgentBlocked && !urgentWorking && hiddenStatuses.includes("done");

    const item = (c) => {
      const origIdx = shown.findIndex((x) => x.id === c.id);
      const { program, name } = tabDisplayInfo(c, allPanes);
      const compactTab = tabWidth < 126;

      return h_flex()
        .id(`tab-${c.id}`)
        .w(tabWidth)
        .min_w(0)
        .h(29)
        .px(compactTab ? 7 : 9)
        .gap(6)
        .rounded(7)
        .items_center()
        .flex_none()
        .text_size(12.5)
        .border(1)
        .border_color(c.active ? t.border : t.chrome)
        .bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .tooltip(`${name}${c.status ? ` (${c.status})` : ""}`)
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = origIdx;
          if (e.click_count === 2) run("tab.rename", { id: c.id });
        })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== origIdx && shown[from]) {
            run("tab.move", { id: shown[from].id, index: origIdx + 1 });
          } else {
            run("tab.select", { id: c.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } });
        })
        .when(Boolean(program?.icon), (el) =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).flex_none().text_color(t.muted)
              : image(program.icon).size(14).flex_none(),
          ),
        )
        .child(div().flex_1().min_w(0).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", (el) =>
          el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)),
        )
        .when(c.status === "blocked" || c.status === "done", (el) =>
          el.child(div().size(6).flex_none().rounded(3).bg(t[c.status])),
        )
        .when(c.active && !compactTab, (el) =>
          el.child(
            div()
              .id(`rename-${c.id}`)
              .flex_none()
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .tooltip("Rename tab (double-click or Cmd+Shift+R)")
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.rename", { id: c.id });
              })
              .child(svg("mods/workspace-chrome/square-pen.svg").size(11)),
          ),
        )
        .when(c.active, (el) =>
          el.child(
            div()
              .id(`close-${c.id}`)
              .flex_none()
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.close", { id: c.id });
              })
              .child(svg("mods/pane/close.svg").size(12)),
          ),
        );
    };

    const panelButton = (id, label, icon, tip) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex()
        .id(`panel-${id}`)
        .h(26)
        .px(compactPanels ? 6 : 8)
        .gap(5)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_size(12)
        .bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .tooltip(tip || label)
        .on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else {
            run("layout.select", { stack: "panel-body", child: id });
            run("layout.show", { id: "panel" });
          }
        })
        .child(svg(icon).size(14))
        .when(!compactPanels, (el) => el.child(label));
    };

    const openTabsDropdown = () => {
      const totalItems = shown.length + otherSpaceAgents.length;
      const popupH = Math.min(450, 96 + Math.max(1, totalItems) * 42 + 48);
      openOverlay({
        mod: "tabs",
        kind: "popup",
        width: 356,
        height: popupH,
        props: {
          overflowMenu: true,
          hiddenIds: overflowTabs.map((c) => c.id),
        },
      });
    };
    this.hiddenIds = overflowTabs.map((c) => c.id);

    const dropdownLabel =
      overflowTabs.length > 0
        ? `+${overflowTabs.length}`
        : allAgents.length > 0
          ? `${allAgents.length}`
          : `${shown.length}`;

    return h_flex()
      .id("tabs-bar")
      .size_full()
      .min_w(0)
      .px(10)
      .pl(lightsPadding)
      .gap(3)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .on_size_change((sz, cx) => {
        if (Math.abs(this.barWidth - sz.width) > 1) {
          this.barWidth = sz.width;
          cx.notify();
        }
      })
      .on_mouse_up("left", () => {
        this.pressed = null;
      })
      .on_scroll_wheel((e) => {
        if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next");
      })
      .child(
        h_flex()
          .id("tab-strip")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(3)
          .overflow_hidden()
          .children(visibleTabs.map(item))
          .when(showDropdownBtn, (el) =>
            el.child(
              h_flex()
                .id("tabs-overflow-btn")
                .h(28)
                .px(8)
                .gap(5)
                .flex_none()
                .items_center()
                .rounded(7)
                .bg(overflowTabs.length > 0 || urgentBlocked ? t.raised : t.chrome)
                .border(1)
                .border_color(urgentBlocked ? t.blocked : overflowTabs.length > 0 ? t.accent : t.border)
                .text_size(11.5)
                .font_medium()
                .text_color(urgentBlocked ? t.blocked : overflowTabs.length > 0 ? t.foreground : t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .tooltip(
                  overflowTabs.length > 0
                    ? `${overflowTabs.length} overflow tab(s) · ${allAgents.length} running agent(s)`
                    : `All tabs & running agents (${allAgents.length} running)`,
                )
                .on_mouse_down("left", stop)
                .on_click(openTabsDropdown)
                .when(urgentBlocked, (sub) => sub.child(div().size(6).rounded_full().bg(t.blocked)))
                .when(urgentWorking, (sub) =>
                  sub.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)),
                )
                .when(urgentDone, (sub) => sub.child(div().size(6).rounded_full().bg(t.done)))
                .child(dropdownLabel)
                .child(svg("mods/files/chevron-down.svg").size(11).text_color(t.muted)),
            ),
          ),
      )
      .child(
        button(
          "tab-new",
          "+",
          () => openOverlay({ mod: "new-menu", kind: "popup", width: 256, height: 552 }),
          "New tab, agent, or worktree",
        ),
      )
      .when(enabled.includes("brain"), (el) =>
        el.child(panelButton("brain", "Brain", "mods/brain/brain.svg", "Artifacts, Markdown & Mermaid Studio (Notes + Plans)")),
      )
      .when(enabled.includes("board"), (el) =>
        el.child(panelButton("board", "Board", "mods/board/board.svg", "Agent Swarm Board & Approvals")),
      )
      .when(enabled.includes("files"), (el) =>
        el.child(panelButton("files", "Files", "mods/files/file.svg", "Files, Markdown & Mermaid Preview")),
      )
      .when(enabled.includes("changes"), (el) =>
        el.child(panelButton("changes", "Changes", "mods/changes/changes.svg", "Git Working Tree Diff")),
      )
      .when(w?.buttons, (el) =>
        el
          .child(
            button(
              "minimize",
              w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−",
              () => run("window.minimize"),
            ),
          )
          .child(
            button(
              "maximize",
              w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□",
              () => run("window.maximize"),
            ),
          )
          .child(
            button(
              "close-window",
              w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13),
              () => run("window.close"),
            ),
          ),
      );
  }
}
