// Modified by Kestrel Contributors (2026) from upstream Herdr (herdr-app, Apache-2.0). See NOTICE.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, agents, focused, exec, hc, run, shared, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.branch = ""; this.ahead = 0; this.behind = 0; this.syncing = false; this.confirmDiscard = null;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const branchInfo = await git(["status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
        let branch = "", ahead = 0, behind = 0;
        if (branchInfo.code === 0) {
          for (const line of branchInfo.stdout.split("\n")) {
            if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
            else if (line.startsWith("# branch.ab ")) {
              const [a, b] = line.slice(12).trim().split(" ");
              ahead = Math.abs(parseInt(a, 10)) || 0;
              behind = Math.abs(parseInt(b, 10)) || 0;
            }
          }
        }
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.branch = branch; this.ahead = ahead; this.behind = behind;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  autoMessage(cx) {
    if (!this.files.length) return;
    const names = this.files.slice(0, 3).map((f) => f.path.split("/").pop());
    const extra = this.files.length > 3 ? ` +${this.files.length - 3} more` : "";
    const allAdded = this.files.every((f) => f.status === "A");
    const allDeleted = this.files.every((f) => f.status === "D");
    const dirs = [...new Set(this.files.map((f) => f.path.includes("/") ? f.path.split("/")[0] : ""))].filter(Boolean);
    const scope = dirs.length === 1 ? `(${dirs[0]})` : "";
    const prefix = allAdded ? `feat${scope}: add` : allDeleted ? `chore${scope}: remove` : `feat${scope}: update`;
    const msg = `${prefix} ${names.join(", ")}${extra}`;
    this.message = msg;
    this.input.set_value(msg);
    cx.notify();
  }

  askAgentReview(cx, targetFile = null) {
    const activeSpace = spaces().find((s) => s.active);
    const prompt = targetFile
      ? `Please review the uncommitted changes in \`${targetFile}\` (\`git diff HEAD -- ${targetFile}\`), check for any bugs or edge cases, and suggest improvements.`
      : `Please review all current uncommitted git changes (\`git diff HEAD\` and \`git status\`) in this repository, flag any bugs or regressions, and summarize your findings.`;
    const spaceAgents = agents().filter((a) => a.space === activeSpace?.id);
    const target = spaceAgents.find((a) => a.focused) ?? spaceAgents[0];
    if (target) {
      this.note = `Sent review request to ${target.title || target.program?.name || target.address}`;
      cx.spawn(async (cx) => {
        try {
          await hc(["send", target.address, prompt]);
          run("agent.focus", { terminal: target.address });
        } catch (e) {
          this.note = `Could not send to agent: ${e}`;
        }
        cx.notify();
      });
    } else {
      const m = shared("vertex")?.model?.trim();
      const argv = m ? ["agy", "--model", m] : ["agy"];
      run("tab.new", { name: "Antigravity", space: activeSpace?.id, folder: this.root, argv, task: prompt });
    }
    cx.notify();
  }

  gitSync(direction, cx) {
    if (!this.root || this.syncing || this.busy) return;
    const root = this.root, on = this.on;
    this.syncing = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const args = direction === "pull" ? ["pull", "--rebase"] : ["push"];
        let r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0 && direction === "push" && /no upstream branch/i.test(r.stderr || "")) {
          r = await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: root, on });
        }
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) {
        this.note = `Git ${direction} failed: ${e}`;
      } finally {
        this.syncing = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  discardFile(file, cx) {
    if (!this.root || this.busy) return;
    if (this.confirmDiscard !== file.path) {
      this.confirmDiscard = file.path;
      cx.notify();
      return;
    }
    this.confirmDiscard = null;
    const root = this.root, on = this.on;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = file.fresh
          ? await exec("git", ["clean", "-f", "--", file.path], { cwd: root, on })
          : await exec("git", ["checkout", "--", file.path], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) {
        this.note = `Discard failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(Boolean(this.branch), (el) => el.child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.accent).max_w(110).truncate().child(this.branch)))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .when(Boolean(this.root), (el) =>
          el
            .child(
              div()
                .id("changes-pull")
                .px(6)
                .py(2)
                .rounded(5)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_size(10.5)
                .text_color(this.behind > 0 ? t.ansi1 : t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .tooltip("Git Pull (--rebase)")
                .on_click((_e, cx) => this.gitSync("pull", cx))
                .child(this.behind > 0 ? `↓${this.behind} Pull` : "↓ Pull"),
            )
            .child(
              div()
                .id("changes-push")
                .px(6)
                .py(2)
                .rounded(5)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_size(10.5)
                .text_color(this.ahead > 0 ? t.ansi2 : t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .tooltip("Git Push")
                .on_click((_e, cx) => this.gitSync("push", cx))
                .child(this.ahead > 0 ? `↑${this.ahead} Push` : "↑ Push"),
            ),
        )
        .when(this.files.length > 0, (el) =>
          el.child(
            div()
              .id("changes-review")
              .px(7)
              .py(2)
              .rounded(5)
              .border_1()
              .border_color(t.accent)
              .bg(t.selected)
              .text_size(10.5)
              .font_semibold()
              .text_color(t.foreground)
              .hover((s) => s.bg(t.hover))
              .cursor_pointer()
              .tooltip("Send current diff to active agent for code review")
              .on_click((_e, cx) => this.askAgentReview(cx, this.open))
              .child("Review Diff"),
          ),
        )
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(
          div()
            .id("changes-close")
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
        ))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        const confirming = this.confirmDiscard === f.path;
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(6).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(240).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
          .child(
            div()
              .id(`change-discard-${f.path}`)
              .px(5)
              .py(1)
              .rounded(4)
              .text_size(10.5)
              .bg(confirming ? t.blocked : t.raised)
              .text_color(confirming ? "#ffffff" : t.dim)
              .hover((s) => s.text_color(confirming ? "#ffffff" : t.blocked).bg(confirming ? t.blocked : t.hover))
              .tooltip(confirming ? "Click again to confirm discard" : "Discard changes to this file")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.discardFile(f, cx);
              })
              .child(confirming ? "Confirm?" : "↺"),
          );
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .when(this.files.length > 0, (el) =>
          el.child(
            div()
              .id("changes-auto-msg")
              .h(32)
              .px(9)
              .flex()
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_color(t.muted)
              .text_size(11.5)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .cursor_pointer()
              .tooltip("Auto-generate conventional commit message from changed files")
              .on_click((_e, cx) => this.autoMessage(cx))
              .child("✨ Auto"),
          ),
        )
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
