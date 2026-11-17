// Modified by Kestrel Contributors (2026) from upstream Herdr (herdr-app, Apache-2.0). See NOTICE.
// Multi-Agent Fleet Board: Kanban view across all coding agents (Antigravity, Claude Code, Codex, Cursor, OpenCode, etc.).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { agents, spaces, terminals, panes, hc, run, openOverlay, theme, shared, setShared, home } from "herdr";

function isAntigravityAgent(a) {
  const app = (a?.app || a?.program?.key || a?.program?.name || "").toLowerCase();
  return app === "antigravity" || app === "agy" || app.includes("antigravity");
}

function bottomChromeText(rawText) {
  const lines = (rawText || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return lines
    .slice(-7)
    .filter((l) => !/^\s*(?:[•*-]|\d+\.)\s/.test(l))
    .join("\n");
}

function parseSwarmScreen(a, rawText) {
  if (!isAntigravityAgent(a)) {
    return { expectsCtrlK: false, swarmBlocked: false, banner: "" };
  }
  const chrome = bottomChromeText(rawText);
  const msg = a?.msg || "";
  const bannerLine =
    chrome
      .split("\n")
      .find((l) =>
        /(?:needs approval for|approve subagent|waiting subagent|subagent.*(?:approval|waiting)|has a question|\bctrl\+k\b\s+to\b|\[ctrl\+k\]|\(ctrl\+k\))/i.test(
          l,
        ),
      ) || "";
  const explicitAlert =
    Boolean(bannerLine) ||
    /(?:needs approval for|approve subagent|waiting subagent|subagent.*(?:approval|waiting)|\bctrl\+k\b)/i.test(msg);
  const hasParentPromptBox =
    /─{8,}\s*\n>\s*\n─{8,}/.test(rawText || "") ||
    (/(?:^|\n)>\s*(?:\n|$)/.test(chrome) && /esc to cancel/i.test(chrome));
  const expectsCtrlK =
    explicitAlert || (a?.status === "blocked" && hasParentPromptBox);
  return {
    expectsCtrlK,
    swarmBlocked: explicitAlert,
    banner: bannerLine.trim(),
  };
}

function needsForegroundConfirmAfterCtrlK(rawText) {
  const chrome = bottomChromeText(rawText);
  const hasParentPromptBox =
    /─{8,}\s*\n>\s*\n─{8,}/.test(rawText || "") ||
    (/(?:^|\n)>\s*(?:\n|$)/.test(chrome) && /esc to cancel/i.test(chrome));
  if (hasParentPromptBox) return false;
  return /(?:Press Enter to return|allow|approve|confirm|\[y\/n\]|yes,\s|run command|apply edit)/i.test(
    chrome,
  );
}

const COLUMNS = [
  { id: "blocked", title: "Needs You", color: "blocked", empty: "No agents waiting on you." },
  { id: "working", title: "Working", color: "working", empty: "No agents actively working." },
  { id: "done", title: "Done", color: "done", empty: "No recently finished agents." },
  { id: "idle", title: "Idle", color: "dim", empty: "No idle agents." },
];

function shortPath(p) {
  if (!p) return "";
  const h = home() || "";
  if (h && p === h) return "~";
  if (h && p.startsWith(h + "/")) return "~/" + p.slice(h.length + 1);
  return p;
}

function resumeCommandFor(s) {
  const vx = { model: "", ...(shared("vertex") ?? {}) };
  const app = (s?.app || "antigravity").toLowerCase();
  let cmd = "agy -c";
  if (app === "antigravity" || app === "agy") {
    cmd = vx.model?.trim()
      ? `agy -c --model '${vx.model.trim().replace(/'/g, "'\\''")}'`
      : "agy -c";
  } else if (app === "claude" || app === "claude-code") {
    cmd = "claude --continue";
  } else if (app === "codex") {
    cmd = "codex resume --last";
  } else if (app === "gemini") {
    cmd = "gemini --resume";
  } else if (app === "opencode") {
    cmd = "opencode --continue";
  } else if (app === "cursor" || app === "cursor-agent") {
    cmd = "cursor-agent";
  }
  if (s?.cwd) {
    const qCwd = "'" + s.cwd.replace(/'/g, "'\\''") + "'";
    return `cd ${qCwd} && ${cmd}`;
  }
  return cmd;
}

export default class Board extends View {
  init(_props, cx) {
    this.snippets = {};
    this.swarmState = {};
    this.inputs = new Map();
    this.restoring = new Set();
    this.focusedInput = null;
    this.filterSpace = null; // null = all spaces
    this.filterStatus = null; // null = all 4 columns (2x2 grid), or "blocked"|"working"|"done"|"idle"
    this.broadcastFocused = false;
    this.broadcastInput = InputState.new({ placeholder: "Broadcast instruction to all shown agents… (↵)" });
    this.broadcastInput.on("focus", (_e, cx) => {
      this.broadcastFocused = true;
      cx.notify();
    });
    this.broadcastInput.on("blur", (_e, cx) => {
      this.broadcastFocused = false;
      cx.notify();
    });
    this.broadcastInput.on("submit", (_e, cx) => this.sendBroadcast(cx));
    this.ensureInputs(cx);
    if (home() !== "/fixture") {
      this.refreshSnippets(cx);
      cx.timer.every(2500, (cx) => {
        this.syncSavedSessions(cx);
        this.refreshSnippets(cx);
      });
    }
  }

  effectiveStatus(a) {
    if ((a?.status ?? "idle") === "blocked") return "blocked";
    if (this.swarmState?.[a?.address]?.swarmBlocked) return "blocked";
    return a?.status ?? "idle";
  }

  isSwarmWaiting(a) {
    if (!isAntigravityAgent(a)) return false;
    if (this.swarmState?.[a?.address]?.expectsCtrlK) return true;
    return /(?:needs approval for|subagent|\bctrl\+k\b)/i.test(a?.msg || "");
  }

  syncSavedSessions(_cx) {
    if (home() === "/fixture") return;
    const allPanes = panes();
    const allAgents = agents();
    const allSpaces = spaces();
    const spaceMap = new Map(allSpaces.map((s) => [s.id, s]));
    const tabMap = new Map(allSpaces.flatMap((s) => (s.tabs ?? []).map((tb) => [tb.id, tb])));
    const prev = shared("savedSessions") ?? {};
    const next = { ...prev };
    let dirty = false;

    if (allPanes.length > 0) {
      const liveTerms = new Set(allPanes.map((p) => p.terminal).filter(Boolean));
      for (const addr of Object.keys(next)) {
        if (!liveTerms.has(addr)) {
          delete next[addr];
          dirty = true;
        }
      }
    }

    for (const a of allAgents) {
      const pn = allPanes.find((p) => p.pane === a.pane || p.terminal === a.address);
      const sp = spaceMap.get(a.space);
      const cwd = a.cwd || pn?.cwd || sp?.folder || next[a.address]?.cwd || "";
      const app = a.app || a.program?.key || next[a.address]?.app || "antigravity";
      const program_name = a.program?.name || next[a.address]?.program_name || "Antigravity";
      const space_name = a.space_name || sp?.name || next[a.address]?.space_name || "";
      const tab_name = a.tab_name || tabMap.get(a.tab)?.name || pn?.title || a.title || next[a.address]?.tab_name || "";
      const cur = next[a.address];
      if (
        !cur ||
        cur.cwd !== cwd ||
        cur.app !== app ||
        cur.program_name !== program_name ||
        cur.space !== a.space ||
        cur.space_name !== space_name ||
        cur.tab !== a.tab ||
        cur.tab_name !== tab_name
      ) {
        next[a.address] = {
          address: a.address,
          pane: a.pane,
          space: a.space,
          space_name,
          tab: a.tab,
          tab_name,
          app,
          program_name,
          cwd,
        };
        dirty = true;
      }
      if (this.restoring.has(a.address)) {
        this.restoring.delete(a.address);
      }
    }

    if (dirty) {
      setShared("savedSessions", next);
    }
  }

  restorableList(allAgents, allPanes, savedMap) {
    const activeAddrs = new Set(allAgents.map((a) => a.address));
    const saved = savedMap ?? shared("savedSessions") ?? {};
    return Object.values(saved).filter((s) => {
      if (!s?.address || activeAddrs.has(s.address)) return false;
      if (this.filterSpace && s.space !== this.filterSpace) return false;
      const pn = allPanes.find((p) => p.terminal === s.address);
      if (!pn) return false;
      if (pn.status || pn.program?.agent) return false;
      return true;
    });
  }

  restoreSessions(cx, sessions) {
    if (!sessions || sessions.length === 0) return;
    for (const s of sessions) {
      this.restoring.add(s.address);
    }
    cx.notify();
    cx.spawn(async (cx) => {
      for (const s of sessions) {
        try {
          await hc(["send", s.address, resumeCommandFor(s)]);
        } catch {}
      }
      this.refreshSnippets(cx);
      cx.notify();
    });
  }

  dismissSavedSession(cx, addr) {
    const prev = shared("savedSessions") ?? {};
    if (!prev[addr]) return;
    const next = { ...prev };
    delete next[addr];
    setShared("savedSessions", next);
    this.restoring.delete(addr);
    cx.notify();
  }

  ensureInputs(cx) {
    for (const a of agents()) {
      this.inputFor(a.address, cx);
    }
  }

  sendBroadcast(cx, overrideText) {
    const text = (overrideText ?? this.broadcastInput.value()).trim();
    if (!text) return;
    if (!overrideText) this.broadcastInput.set_value("");
    const targets = agents()
      .filter((a) => !this.filterSpace || a.space === this.filterSpace)
      .filter((a) => !this.filterStatus || (a.status ?? "idle") === this.filterStatus)
      .map((a) => a.address);
    if (targets.length === 0) return;
    cx.spawn(async (cx) => {
      for (const addr of targets) {
        try {
          await hc(["send", addr, text]);
        } catch {}
      }
      this.refreshSnippets(cx);
      cx.notify();
    });
  }

  inputFor(addr, cx) {
    let inp = this.inputs.get(addr);
    if (!inp) {
      inp = InputState.new({ placeholder: "Send prompt or reply to agent… (↵)" });
      inp.on("focus", (_e, cx) => {
        this.focusedInput = addr;
        cx.notify();
      });
      inp.on("blur", (_e, cx) => {
        if (this.focusedInput === addr) this.focusedInput = null;
        cx.notify();
      });
      inp.on("submit", (_e, cx) => {
        const text = inp.value().trim();
        if (!text) return;
        inp.set_value("");
        cx.spawn(async (cx) => {
          try {
            await hc(["send", addr, text]);
          } catch {}
          this.refreshSnippets(cx);
          cx.notify();
        });
      });
      this.inputs.set(addr, inp);
    }
    return inp;
  }

  refreshSnippets(cx) {
    this.ensureInputs(cx);
    if (home() === "/fixture") return;
    const list = agents();
    if (list.length === 0) {
      this.swarmState = {};
      return;
    }
    cx.spawn(async (cx) => {
      const next = { ...this.snippets };
      const nextSwarm = {};
      for (const a of list.slice(0, 16)) {
        try {
          const r = await hc(["read", a.address, "--lines", "16"]);
          if (r.code === 0 && r.stdout) {
            if (isAntigravityAgent(a)) {
              nextSwarm[a.address] = parseSwarmScreen(a, r.stdout);
            }
            const clean = r.stdout
              .split("\n")
              .map((l) => l.trimEnd())
              .filter((l) => l.trim().length > 0 && !/^─{8,}$/.test(l.trim()))
              .slice(-4)
              .join("\n");
            if (clean) next[a.address] = clean;
          }
        } catch {}
      }
      this.snippets = next;
      this.swarmState = nextSwarm;
      cx.notify();
    });
  }

  sendKeys(cx, addr, ...keys) {
    cx.spawn(async (cx) => {
      try {
        await hc(["keys", addr, ...keys]);
      } catch {}
      this.refreshSnippets(cx);
      cx.notify();
    });
  }

  async approveTerminal(cx, a, mode = "once", drainQueue = false) {
    const addr = a.address;
    if (mode === "swarm") {
      try {
        await hc(["keys", addr, "ctrl+k"]);
      } catch {}
      await new Promise((resolve) => cx.timer.after(200, resolve));
      try {
        const r2 = await hc(["read", addr, "--lines", "16"]);
        if (r2.code === 0 && needsForegroundConfirmAfterCtrlK(r2.stdout || "")) {
          await hc(["keys", addr, "enter"]);
        }
      } catch {}
      return;
    }
    if (isAntigravityAgent(a)) {
      let screen = "";
      try {
        const r = await hc(["read", addr, "--lines", "16"]);
        if (r.code === 0) screen = r.stdout || "";
      } catch {}
      const parsed = parseSwarmScreen(a, screen);
      const useCtrlK = parsed.expectsCtrlK || this.isSwarmWaiting(a);
      if (useCtrlK) {
        const maxSteps = drainQueue ? 6 : 1;
        for (let step = 0; step < maxSteps; step++) {
          try {
            await hc(["keys", addr, "ctrl+k"]);
          } catch {}
          await new Promise((resolve) => cx.timer.after(220, resolve));
          let afterScreen = "";
          try {
            const r2 = await hc(["read", addr, "--lines", "16"]);
            if (r2.code === 0) afterScreen = r2.stdout || "";
          } catch {}
          if (needsForegroundConfirmAfterCtrlK(afterScreen)) {
            try {
              await hc(["keys", addr, mode === "session" ? "a" : "enter"]);
            } catch {}
            break;
          }
          if (!drainQueue) break;
          const nextState = parseSwarmScreen({ ...a, status: "working", msg: "" }, afterScreen);
          if (!nextState.swarmBlocked) break;
        }
        return;
      }
    }
    try {
      await hc(["keys", addr, mode === "session" ? "a" : "enter"]);
    } catch {}
  }

  approveSingle(cx, a, mode = "once") {
    cx.spawn(async (cx) => {
      await this.approveTerminal(cx, a, mode, false);
      this.refreshSnippets(cx);
      cx.notify();
    });
  }

  batchApproveBlocked(cx, list, allTerms, mode = "once") {
    const byAddr = new Map(list.map((a) => [a.address, a]));
    const targets = new Map();
    for (const a of list) {
      if (this.effectiveStatus(a) === "blocked") {
        targets.set(a.address, a);
      }
    }
    for (const term of allTerms) {
      if (term.state === "live" && (term.status === "blocked" || term.status === "error") && !targets.has(term.address)) {
        targets.set(term.address, byAddr.get(term.address) || term);
      }
    }
    if (targets.size === 0) return;
    cx.spawn(async (cx) => {
      for (const a of targets.values()) {
        await this.approveTerminal(cx, a, mode, true);
      }
      this.refreshSnippets(cx);
      cx.notify();
    });
  }

  batchKeyBlocked(cx, list, allTerms, ...keys) {
    const targets = new Set(
      list.filter((a) => this.effectiveStatus(a) === "blocked").map((a) => a.address),
    );
    for (const term of allTerms) {
      if (term.state === "live" && (term.status === "blocked" || term.status === "error")) {
        targets.add(term.address);
      }
    }
    if (targets.size === 0) return;
    cx.spawn(async (cx) => {
      for (const addr of targets) {
        try {
          await hc(["keys", addr, ...keys]);
        } catch {}
      }
      this.refreshSnippets(cx);
      cx.notify();
    });
  }

  card(t, a, spaceMap, paneMap, childCount, cx) {
    const sp = spaceMap.get(a.space);
    const pn = paneMap.get(a.pane);
    const cwd = a.cwd || pn?.cwd || sp?.folder || "";
    const branch = a.branch || pn?.branch || sp?.branch;
    const snippet = this.snippets[a.address];
    const inp = this.inputs.get(a.address);
    const effStatus = this.effectiveStatus(a);
    const swarmWaiting = this.isSwarmWaiting(a);
    const swarmBanner = this.swarmState?.[a.address]?.banner || "";
    const displayMsg = a.msg || swarmBanner;
    const statusColor =
      effStatus === "blocked"
        ? t.blocked
        : effStatus === "working"
          ? t.working
          : effStatus === "done"
            ? t.done
            : t.dim;

    return v_flex()
      .id(`bd-card-${a.address}`)
      .w_full()
      .p(9)
      .gap(6)
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(a.focused ? t.accent : effStatus === "blocked" ? t.blocked : t.border)
      .child(
        // Top row: icon, agent title, address badge
        h_flex()
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click(() => {
            if (shared("layout") === "board") run("layout.switch", { name: "main" });
            run("agent.focus", { terminal: a.address });
          })
          .when(Boolean(a.program?.icon), (el) =>
            el.child(
              a.program.tint
                ? svg(a.program.icon).size(14).text_color(t.foreground)
                : image(a.program.icon).size(14),
            ),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .font_semibold()
              .text_size(12)
              .text_color(t.foreground)
              .child(a.title || a.tab_name || a.program?.name || "Agent"),
          )
          .when(effStatus === "working", (el) =>
            el.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)),
          )
          .when(effStatus !== "working", (el) =>
            el.child(div().size(7).rounded(4).bg(statusColor)),
          )
          .child(div().text_size(10.5).text_color(t.dim).child(a.address)),
      )
      .child(
        // Working directory (cwd) + git branch metadata row
        v_flex()
          .gap(3)
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .text_size(11)
              .text_color(t.muted)
              .child(div().truncate().font_medium().child(a.space_name || sp?.name || "Workspace"))
              .when(Boolean(branch), (el) =>
                el.child(
                  h_flex()
                    .gap(3)
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.background)
                    .items_center()
                    .child(svg("mods/workspace-chrome/branch.svg").size(10))
                    .child(div().max_w(100).truncate().child(branch)),
                ),
              )
              .when(childCount > 0, (el) =>
                el.child(
                  div()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.background)
                    .text_color(t.accent)
                    .child(`${childCount} sub`),
                ),
              ),
          )
          .when(Boolean(cwd), (el) =>
            el.child(
              div()
                .w_full()
                .truncate()
                .text_size(10.5)
                .text_color(t.dim)
                .tooltip(cwd)
                .child(`📁 ${shortPath(cwd)}`),
            ),
          ),
      )
      .when(Boolean(displayMsg), (el) =>
        el.child(
          div()
            .w_full()
            .px(7)
            .py(4)
            .rounded(5)
            .bg(t.background)
            .border(1)
            .border_color(effStatus === "blocked" ? t.blocked : t.border)
            .text_size(10.8)
            .text_color(effStatus === "blocked" ? t.blocked : t.foreground)
            .truncate()
            .tooltip(displayMsg)
            .child(displayMsg),
        ),
      )
      .when(effStatus === "blocked", (el) =>
        el.child(
          h_flex()
            .w_full()
            .gap(5)
            .items_center()
            .child(
              div()
                .id(`bd-approve-${a.address}`)
                .px(7)
                .py(3)
                .rounded(4)
                .bg(t.done)
                .text_size(10.5)
                .font_semibold()
                .text_color(t.accent_foreground)
                .hover((s) => s.opacity(0.9))
                .cursor_pointer()
                .tooltip(
                  swarmWaiting
                    ? "Approve Antigravity swarm subagent (sends Ctrl+K)"
                    : "Approve pending request (auto-detects Swarm Ctrl+K vs Enter)",
                )
                .on_click((_e, cx) => this.approveSingle(cx, a, "once"))
                .child(swarmWaiting ? "✓ Approve (^K)" : "✓ Approve"),
            )
            .when(isAntigravityAgent(a) && !swarmWaiting, (el2) =>
              el2.child(
                div()
                  .id(`bd-approve-swarm-${a.address}`)
                  .px(7)
                  .py(3)
                  .rounded(4)
                  .bg(t.background)
                  .border(1)
                  .border_color(t.accent)
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.accent)
                  .hover((s) => s.bg(t.hover))
                  .cursor_pointer()
                  .tooltip("Approve waiting Antigravity swarm subagent via Ctrl+K")
                  .on_click((_e, cx) => this.approveSingle(cx, a, "swarm"))
                  .child("^K Swarm"),
              ),
            )
            .child(
              div()
                .id(`bd-approve-sess-${a.address}`)
                .px(7)
                .py(3)
                .rounded(4)
                .bg(t.background)
                .border(1)
                .border_color(t.done)
                .text_size(10.5)
                .font_medium()
                .text_color(t.done)
                .hover((s) => s.bg(t.hover))
                .cursor_pointer()
                .tooltip("Approve for entire session (sends 'a', or Ctrl+K then 'a' for swarm)")
                .on_click((_e, cx) => this.approveSingle(cx, a, "session"))
                .child("✓✓ Session"),
            )
            .child(
              div()
                .id(`bd-deny-${a.address}`)
                .px(7)
                .py(3)
                .rounded(4)
                .bg(t.background)
                .border(1)
                .border_color(t.blocked)
                .text_size(10.5)
                .font_medium()
                .text_color(t.blocked)
                .hover((s) => s.bg(t.hover))
                .cursor_pointer()
                .tooltip("Deny / reject pending permission request (sends Esc)")
                .on_click((_e, cx) => this.sendKeys(cx, a.address, "esc"))
                .child("✕ Deny"),
            ),
        ),
      )
      .when(Boolean(snippet), (el) =>
        el.child(
          div()
            .w_full()
            .p(6)
            .rounded(5)
            .bg(t.background)
            .border(1)
            .border_color(t.border)
            .text_size(10.5)
            .text_color(t.muted)
            .child(snippet),
        ),
      )
      .when(Boolean(inp), (el) =>
        el.child(
          Input.new(inp)
            .h(25)
            .px(7)
            .items_center()
            .rounded(5)
            .border(1)
            .border_color(this.focusedInput === a.address ? t.accent : t.input)
            .bg(t.background)
            .text_size(11)
            .text_color(t.foreground),
        ),
      )
      .when(!inp, (el) =>
        el.child(
          div()
            .id(`bd-init-inp-${a.address}`)
            .h(25)
            .px(7)
            .flex()
            .items_center()
            .rounded(5)
            .border(1)
            .border_color(t.input)
            .bg(t.background)
            .text_size(11)
            .text_color(t.dim)
            .cursor_text()
            .on_click((_e, cx) => {
              const created = this.inputFor(a.address, cx);
              created.focus();
              cx.notify();
            })
            .child("Send prompt or reply to agent… (↵)"),
        ),
      )
      .child(
        // Card action buttons
        h_flex()
          .justify_between()
          .items_center()
          .text_size(10.5)
          .child(
            h_flex()
              .gap(5)
              .child(
                div()
                  .id(`bd-focus-${a.address}`)
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.background)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .on_click(() => {
                    if (shared("layout") === "board") run("layout.switch", { name: "main" });
                    run("agent.focus", { terminal: a.address });
                  })
                  .child("Focus"),
              )
              .child(
                div()
                  .id(`bd-peek-${a.address}`)
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .bg(t.background)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .on_click(() => run("terminal.peek", { terminal: a.address }))
                  .child("Peek"),
              )
              .when(isAntigravityAgent(a), (el) =>
                el
                  .child(
                    div()
                      .id(`bd-mode-${a.address}`)
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .bg(t.background)
                      .text_color(t.muted)
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .cursor_pointer()
                      .tooltip("Cycle Antigravity execution mode (accept-edits ⇄ auto ⇄ plan) via Shift+Tab")
                      .on_click((_e, cx) => this.sendKeys(cx, a.address, "shift+tab"))
                      .child("Mode ⟳"),
                  )
                  .child(
                    div()
                      .id(`bd-card-swarm-${a.address}`)
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .bg(t.background)
                      .text_color(swarmWaiting ? t.accent : t.muted)
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .cursor_pointer()
                      .tooltip("Approve waiting Antigravity swarm subagent (sends Ctrl+K)")
                      .on_click((_e, cx) => this.approveSingle(cx, a, "swarm"))
                      .child("Swarm ^K"),
                  ),
              ),
          )
          .child(div().text_color(t.dim).child(a.program?.name ?? a.app ?? "")),
      );
  }

  renderColumn(t, col, list, allTerms, spaceMap, paneMap, cx) {
    const members = list.filter((a) => this.effectiveStatus(a) === col.id);
    const dotColor = col.color === "dim" ? t.dim : t[col.color] ?? t.accent;
    return v_flex()
      .id(`bd-col-${col.id}`)
      .flex_1()
      .min_w(130)
      .h_full()
      .min_h(0)
      .rounded(8)
      .bg(t.chrome)
      .border(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id(`bd-col-hdr-${col.id}`)
          .h(28)
          .px(9)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.filterStatus = this.filterStatus === col.id ? null : col.id;
            cx.notify();
          })
          .child(div().size(7).rounded(4).bg(dotColor))
          .child(div().flex_1().font_semibold().text_size(11.5).text_color(t.foreground).child(col.title))
          .child(div().text_size(11).text_color(t.dim).child(String(members.length))),
      )
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            v_flex()
              .id(`bd-scroll-${col.id}`)
              .size_full()
              .p(7)
              .gap(7)
              .overflow_y_scroll()
              .when(members.length === 0, (el) =>
                el.child(div().p(6).text_size(11).text_color(t.dim).child(col.empty)),
              )
              .children(
                members.map((a) => {
                  const kids = allTerms.filter((term) => term.parent === a.address).length;
                  return this.card(t, a, spaceMap, paneMap, kids, cx);
                }),
              ),
          )
          .child(Scrollbar.vertical(`bd-scroll-${col.id}`).absolute().inset_0()),
      );
  }

  render(cx) {
    const t = theme();
    const allSpaces = spaces();
    const activeSpace = allSpaces.find((s) => s.active);
    const spaceMap = new Map(allSpaces.map((s) => [s.id, s]));
    const allPanes = panes();
    const paneMap = new Map(allPanes.map((p) => [p.pane, p]));
    const allTerms = terminals();
    const allAgents = agents();
    const list = allAgents.filter((a) => !this.filterSpace || a.space === this.filterSpace);
    const savedMap = shared("savedSessions") ?? {};
    const savedCount = Object.keys(savedMap).length;
    const restorable = this.restorableList(allAgents, allPanes, savedMap);
    const autoRestoreOn = Boolean(shared("autoRestoreSessions"));
    const vx = { model: "", ...(shared("vertex") ?? {}) };
    const agyArgv = vx.model?.trim() ? ["agy", "--model", vx.model.trim()] : ["agy"];

    const counts = {
      blocked: list.filter((a) => this.effectiveStatus(a) === "blocked").length,
      working: list.filter((a) => this.effectiveStatus(a) === "working").length,
      done: list.filter((a) => this.effectiveStatus(a) === "done").length,
      idle: list.filter((a) => this.effectiveStatus(a) === "idle").length,
    };
    const agyActive = list.filter(
      (a) => isAntigravityAgent(a) && (this.effectiveStatus(a) === "blocked" || a.status === "working"),
    );

    return v_flex()
      .id("fleet-board")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .text_size(12.5)
      .child(
        // Top toolbar
        h_flex()
          .h(36)
          .px(12)
          .gap(8)
          .items_center()
          .justify_between()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(7)
              .items_center()
              .child(svg("mods/board/board.svg").size(14).text_color(t.accent))
              .child(div().font_semibold().text_color(t.foreground).child("Fleet Board"))
              .child(div().text_size(11).text_color(t.dim).child(`${list.length}`))
              .when(savedCount > 0, (el) =>
                el.child(
                  div()
                    .id("bd-auto-restore-toggle")
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .bg(autoRestoreOn ? t.selected : t.raised)
                    .text_size(10.5)
                    .text_color(autoRestoreOn ? t.accent : t.dim)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .cursor_pointer()
                    .tooltip(
                      `${savedCount} session(s) saved for reboot recovery.\nClick to toggle Auto-Restore on launch (${autoRestoreOn ? "On" : "Off"}).`,
                    )
                    .on_click((_e, cx) => {
                      setShared("autoRestoreSessions", !autoRestoreOn);
                      cx.notify();
                    })
                    .child(`💾 ${savedCount} saved · Auto: ${autoRestoreOn ? "On" : "Off"}`),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(
                div()
                  .id("bd-filter-toggle")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .bg(this.filterSpace ? t.selected : t.raised)
                  .text_size(11)
                  .text_color(this.filterSpace ? t.foreground : t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .on_click((_e, cx) => {
                    this.filterSpace = this.filterSpace ? null : activeSpace?.id ?? null;
                    cx.notify();
                  })
                  .child(this.filterSpace ? "Current space" : "All spaces"),
              )
              .child(
                div()
                  .id("bd-new-wt")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(t.foreground)
                  .hover((s) => s.bg(t.selected))
                  .cursor_pointer()
                  .on_click(() =>
                    openOverlay({
                      mod: "worktree",
                      kind: "dialog",
                      width: 520,
                      height: 440,
                      props: {
                        space: activeSpace?.id,
                        folder: panes().find((p) => p.focused)?.cwd || activeSpace?.folder,
                        action: "new",
                        tab: "Antigravity",
                        argv: agyArgv,
                      },
                    }),
                  )
                  .child("+ Worktree"),
              )
              .child(
                div()
                  .id("bd-new-agy")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(t.foreground)
                  .hover((s) => s.bg(t.selected))
                  .cursor_pointer()
                  .on_click(() => run("tab.new", { name: "Antigravity", space: activeSpace?.id, argv: agyArgv }))
                  .child("+ agy"),
              )
              .child(
                div()
                  .id("bd-close")
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .text_size(12)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .tooltip("Close panel (Cmd+Shift+A)")
                  .on_click(() => run("layout.hide", { id: "panel" }))
                  .child("×"),
              ),
          ),
      )
      .child(
        // Status Filter Bar (shows all 4 status counts even in narrow side panel)
        h_flex()
          .h(30)
          .px(10)
          .gap(5)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .id("bd-st-all")
              .px(7)
              .py(2)
              .rounded(4)
              .bg(this.filterStatus === null ? t.selected : t.raised)
              .text_size(10.8)
              .font_medium()
              .text_color(this.filterStatus === null ? t.foreground : t.muted)
              .cursor_pointer()
              .on_click((_e, cx) => {
                this.filterStatus = null;
                cx.notify();
              })
              .child(`All (${list.length})`),
          )
          .children(
            COLUMNS.map((col) => {
              const active = this.filterStatus === col.id;
              const cnt = counts[col.id] ?? 0;
              const dotColor = col.color === "dim" ? t.dim : t[col.color] ?? t.accent;
              return h_flex()
                .id(`bd-st-${col.id}`)
                .px(7)
                .py(2)
                .gap(4)
                .items_center()
                .rounded(4)
                .bg(active ? t.selected : t.raised)
                .text_size(10.8)
                .text_color(active ? t.foreground : t.muted)
                .cursor_pointer()
                .on_click((_e, cx) => {
                  this.filterStatus = active ? null : col.id;
                  cx.notify();
                })
                .child(div().size(6).rounded(3).bg(dotColor))
                .child(`${col.title} (${cnt})`);
            }),
          ),
      )
      .child(
        // Central Pending Approvals Bar
        h_flex()
          .h(32)
          .px(10)
          .gap(6)
          .items_center()
          .justify_between()
          .bg(counts.blocked > 0 ? t.blocked + "18" : t.chrome)
          .border_b(1)
          .border_color(counts.blocked > 0 ? t.blocked : t.border)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .flex_1()
              .child(div().size(7).rounded(4).bg(counts.blocked > 0 ? t.blocked : t.done))
              .child(
                div()
                  .text_size(11)
                  .font_semibold()
                  .text_color(counts.blocked > 0 ? t.blocked : t.muted)
                  .child("Pending Approvals:"),
              )
              .child(
                div()
                  .text_size(11)
                  .truncate()
                  .text_color(counts.blocked > 0 ? t.foreground : t.dim)
                  .child(
                    counts.blocked > 0
                      ? `${counts.blocked} agent${counts.blocked === 1 ? "" : "s"} waiting for approval`
                      : "All clear — no agents waiting",
                  ),
              ),
          )
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .when(counts.blocked > 0, (el) =>
                el
                  .child(
                    div()
                      .id("bd-approve-all")
                      .px(8)
                      .py(2)
                      .rounded(4)
                      .bg(t.done)
                      .text_size(10.8)
                      .font_semibold()
                      .text_color(t.accent_foreground)
                      .hover((s) => s.opacity(0.9))
                      .cursor_pointer()
                      .tooltip("Approve all waiting agents & Antigravity swarm subagents (auto-detects Ctrl+K vs Enter)")
                      .on_click((_e, cx) => this.batchApproveBlocked(cx, list, allTerms, "once"))
                      .child(`✓ Approve All (${counts.blocked})`),
                  )
                  .child(
                    div()
                      .id("bd-approve-sess-all")
                      .px(7)
                      .py(2)
                      .rounded(4)
                      .bg(t.raised)
                      .border(1)
                      .border_color(t.done)
                      .text_size(10.5)
                      .font_medium()
                      .text_color(t.done)
                      .hover((s) => s.bg(t.hover))
                      .cursor_pointer()
                      .tooltip("Approve for the session across all waiting agents (sends 'a' or Swarm Ctrl+K)")
                      .on_click((_e, cx) => this.batchApproveBlocked(cx, list, allTerms, "session"))
                      .child("✓✓ Session All"),
                  ),
              )
              .when(agyActive.length > 0, (el) =>
                el.child(
                  div()
                    .id("bd-swarm-approve-all")
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.accent)
                    .text_size(10.5)
                    .font_semibold()
                    .text_color(t.accent)
                    .hover((s) => s.bg(t.selected))
                    .cursor_pointer()
                    .tooltip("Send Ctrl+K directly to active/waiting Antigravity swarm session(s)")
                    .on_click((_e, cx) => {
                      cx.spawn(async (cx) => {
                        for (const a of agyActive) {
                          await this.approveTerminal(cx, a, "swarm", false);
                        }
                        this.refreshSnippets(cx);
                        cx.notify();
                      });
                    })
                    .child("⚡ Swarm ^K"),
                ),
              )
              .when(counts.blocked > 0, (el) =>
                el.child(
                  div()
                    .id("bd-deny-all")
                    .px(6)
                    .py(2)
                    .rounded(4)
                    .bg(t.raised)
                    .border(1)
                    .border_color(t.blocked)
                    .text_size(10.5)
                    .text_color(t.blocked)
                    .hover((s) => s.bg(t.hover))
                    .cursor_pointer()
                    .tooltip("Send Esc to deny all blocked agents & subagents")
                    .on_click((_e, cx) => this.batchKeyBlocked(cx, list, allTerms, "esc"))
                    .child("✕ Deny All"),
                ),
              ),
          ),
      )
      .when(restorable.length > 0, (el) =>
        el.child(
          v_flex()
            .px(10)
            .py(7)
            .gap(5)
            .bg(t.raised)
            .border_b(1)
            .border_color(t.accent)
            .child(
              h_flex()
                .justify_between()
                .items_center()
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(div().size(7).rounded(4).bg(t.accent))
                    .child(
                      div()
                        .text_size(11)
                        .font_semibold()
                        .text_color(t.accent)
                        .child(`Restore Previous Sessions (${restorable.length}):`),
                    )
                    .child(
                      div()
                        .text_size(10.8)
                        .text_color(t.muted)
                        .child("Shells ready to resume in their project directories"),
                    ),
                )
                .child(
                  div()
                    .id("bd-restore-all")
                    .px(8)
                    .py(2)
                    .rounded(4)
                    .bg(t.accent)
                    .text_size(10.8)
                    .font_semibold()
                    .text_color(t.accent_foreground)
                    .hover((s) => s.opacity(0.9))
                    .cursor_pointer()
                    .tooltip("Resume all saved sessions in one click (cd <cwd> && agy -c / claude --continue)")
                    .on_click((_e, cx) => this.restoreSessions(cx, restorable))
                    .child(`↻ Restore All (${restorable.length})`),
                ),
            )
            .child(
              h_flex()
                .gap(6)
                .flex_wrap()
                .children(
                  restorable.map((s) => {
                    const isRestoring = this.restoring.has(s.address);
                    const labelText = s.tab_name || s.space_name || s.program_name || s.address;
                    return h_flex()
                      .id(`bd-rest-chip-${s.address}`)
                      .px(7)
                      .py(3)
                      .gap(5)
                      .items_center()
                      .rounded(5)
                      .bg(t.background)
                      .border(1)
                      .border_color(t.border)
                      .text_size(10.8)
                      .child(
                        div()
                          .font_medium()
                          .text_color(t.foreground)
                          .tooltip(`${labelText} (${s.program_name || s.app})\n📁 ${s.cwd || "~"}\nRuns: ${resumeCommandFor(s)}`)
                          .child(`${labelText} · ${shortPath(s.cwd || "~")}`),
                      )
                      .child(
                        div()
                          .id(`bd-rest-one-${s.address}`)
                          .px(6)
                          .py(1)
                          .rounded(4)
                          .bg(t.accent)
                          .text_size(10)
                          .font_semibold()
                          .text_color(t.accent_foreground)
                          .hover((st) => st.opacity(0.9))
                          .cursor_pointer()
                          .tooltip(`Run: ${resumeCommandFor(s)}`)
                          .on_click((_e, cx) => this.restoreSessions(cx, [s]))
                          .child(isRestoring ? "Resuming…" : "↻ Resume"),
                      )
                      .child(
                        div()
                          .id(`bd-rest-dismiss-${s.address}`)
                          .px(4)
                          .py(1)
                          .rounded(4)
                          .text_size(10)
                          .text_color(t.dim)
                          .hover((st) => st.bg(t.hover).text_color(t.foreground))
                          .cursor_pointer()
                          .tooltip("Dismiss saved session")
                          .on_click((_e, cx) => this.dismissSavedSession(cx, s.address))
                          .child("✕"),
                      );
                  }),
                ),
            ),
        ),
      )
      .child(
        // Fleet Broadcast Bar
        h_flex()
          .h(34)
          .px(10)
          .gap(6)
          .items_center()
          .bg(t.raised)
          .border_b(1)
          .border_color(t.border)
          .child(div().text_size(11).font_semibold().text_color(t.accent).child("Broadcast:"))
          .child(
            div()
              .flex_1()
              .min_w(90)
              .child(
                Input.new(this.broadcastInput)
                  .h(24)
                  .px(7)
                  .items_center()
                  .rounded(5)
                  .border(1)
                  .border_color(this.broadcastFocused ? t.accent : t.input)
                  .bg(t.background)
                  .text_size(11)
                  .text_color(t.foreground),
              ),
          )
          .children(
            [
              ["status", "Status", "Briefly summarize your current progress and any blockers."],
              ["tests", "Tests", "Run the relevant test suite and report any failures."],
              ["review", "Review", "Inspect `git diff HEAD` and verify there are no regressions or debug leftovers."],
            ].map(([id, label, prompt]) =>
              div()
                .id(`bd-bc-preset-${id}`)
                .px(6)
                .py(2)
                .rounded(4)
                .border(1)
                .border_color(t.border)
                .bg(t.chrome)
                .text_size(10.5)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .on_click((_e, cx) => {
                  this.broadcastInput.set_value(prompt);
                  cx.notify();
                })
                .child(label),
            ),
          )
          .child(
            div()
              .id("bd-bc-send")
              .px(8)
              .py(2)
              .rounded(5)
              .bg(t.accent)
              .text_size(11)
              .font_semibold()
              .text_color(t.accent_foreground)
              .hover((s) => s.opacity(0.9))
              .cursor_pointer()
              .on_click((_e, cx) => this.sendBroadcast(cx))
              .child("Send"),
          ),
      )
      .child(
        // Board Body: either a single focused status column or a 2x2 grid (Needs You + Working / Done + Idle)
        // so all 4 statuses fit cleanly inside both the 420px side panel and the full-window layout.
        this.filterStatus
          ? div()
              .flex_1()
              .min_h(0)
              .p(8)
              .child(
                this.renderColumn(
                  t,
                  COLUMNS.find((c) => c.id === this.filterStatus) ?? COLUMNS[0],
                  list,
                  allTerms,
                  spaceMap,
                  paneMap,
                  cx,
                ),
              )
          : v_flex()
              .flex_1()
              .min_h(0)
              .p(8)
              .gap(8)
              .child(
                h_flex()
                  .flex_1()
                  .min_h(0)
                  .gap(8)
                  .child(this.renderColumn(t, COLUMNS[0], list, allTerms, spaceMap, paneMap, cx))
                  .child(this.renderColumn(t, COLUMNS[1], list, allTerms, spaceMap, paneMap, cx)),
              )
              .child(
                h_flex()
                  .flex_1()
                  .min_h(0)
                  .gap(8)
                  .child(this.renderColumn(t, COLUMNS[2], list, allTerms, spaceMap, paneMap, cx))
                  .child(this.renderColumn(t, COLUMNS[3], list, allTerms, spaceMap, paneMap, cx)),
              ),
      );
  }
}
