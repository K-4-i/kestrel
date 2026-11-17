// Copyright 2026 Kestrel Contributors. Licensed under Apache-2.0. See NOTICE.
// Universal Brain, Artifacts Studio & Shared Notes across all coding agents (Antigravity, Claude Code, Codex, Cursor, OpenCode, etc.).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, Editor, EditorState, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  spaces,
  panes,
  agents,
  terminals,
  focused,
  exec,
  hc,
  openOverlay,
  readTextFile,
  watchFolder,
  home,
  appHome,
  theme,
  settings,
  shared,
  setShared,
  props,
  run,
} from "herdr";
import {
  MD_EXTS,
  IMG_EXTS,
  extOf,
  createDocState,
  ensureImageAsset,
  renderRichMarkdown,
} from "./doc-render.js";

function activeLocation() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || home(), on, space: space?.id };
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function baseName(p) {
  return (p || "").split(/[\\/]/).pop() || "Artifact";
}

function dirName(p) {
  if (!p) return "";
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "/";
}

export default class Brain extends View {
  init(_props, cx) {
    const p = props() || {};
    this.mode = p.mode || shared("brain.mode") || "artifacts"; // "artifacts" | "notes"
    this.filter = "all"; // "all" | "space" | "antigravity" | "workspace" | "images"
    this.previewMode = true; // true = Rich Markdown + Mermaid + Image, false = Raw Code
    this.rawEditor = null;
    this.docState = createDocState();

    this.noteScope = "workspace";
    this.noteText = "";
    this.editingNotes = false;
    this.noteStatus = "";
    this.quickFocused = false;
    this.quickInput = InputState.new({ placeholder: "Add a quick note… (↵ appends with timestamp)" });
    this.quickInput.on("focus", (_e, cx) => {
      this.quickFocused = true;
      cx.notify();
    });
    this.quickInput.on("blur", (_e, cx) => {
      this.quickFocused = false;
      cx.notify();
    });
    this.quickInput.on("submit", (_e, cx) => this.appendQuickNote(cx));

    this.notesEditor = TextareaState.new({
      value: "",
      placeholder: "# Workspace Notes\n\nWrite notes here, or ask any agent to read/update NOTES.md…",
      rows: 12,
    });

    this.items = [];
    this.selected = null;
    this.content = "";
    this.watchedDir = null;
    this.lastCwd = null;

    if (home() !== "/fixture") {
      this.refresh(cx);
      cx.timer.every(6000, (cx) => this.refresh(cx));
    }
  }

  watchSelectedDir(dir, on, cx) {
    if (home() === "/fixture" || on || !dir || this.watchedDir === dir) return;
    this.watchedDir = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watchedDir === dir) {
          await watchFolder(dir);
          if (this.watchedDir === dir && this.selected) {
            await this.selectItem(this.selected, on, cx, true);
            cx.notify();
          }
        }
      } catch {
        if (this.watchedDir === dir) this.watchedDir = null;
      }
    });
  }

  notePath(loc = activeLocation()) {
    if (this.noteScope === "global") {
      return { path: `${appHome()}/notes.md`, on: null, label: "~/.config/kestrel/notes.md" };
    }
    const base = (loc.cwd || home()).replace(/\/+$/, "");
    return { path: `${base}/NOTES.md`, on: loc.on, label: `${base.split("/").pop() || "workspace"}/NOTES.md` };
  }

  async loadNotes(loc = activeLocation()) {
    if (home() === "/fixture") return;
    const target = this.notePath(loc);
    try {
      const text = await readTextFile(target.path, { on: target.on });
      const val = text ?? "";
      this.noteText = val;
      if (!this.editingNotes) {
        this.notesEditor.set_value(val);
      }
    } catch {}
  }

  async saveNotesText(newText, cx) {
    const loc = activeLocation();
    const target = this.notePath(loc);
    try {
      const r = await exec(
        "sh",
        ["-c", 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', "sh", target.path, newText],
        { on: target.on },
      );
      if (r.code === 0) {
        this.noteText = newText;
        this.notesEditor.set_value(newText);
        this.noteStatus = "Saved";
      } else {
        this.noteStatus = r.stderr || "Save failed";
      }
    } catch (e) {
      this.noteStatus = `Save failed: ${e}`;
    }
    cx.notify();
  }

  appendQuickNote(cx) {
    const entry = this.quickInput.value().trim();
    if (!entry) return;
    this.quickInput.set_value("");
    const header = this.noteScope === "global" ? "# Global Scratchpad\n\n" : "# Workspace Notes\n\n";
    const base = this.noteText.trim() ? `${this.noteText.replace(/\s+$/, "")}\n\n` : header;
    const updated = `${base}- **[${nowStamp()} · You]** ${entry}\n`;
    cx.spawn(async (cx) => {
      await this.saveNotesText(updated, cx);
      this.refresh(cx);
    });
  }

  askAgentToWriteNote(cx) {
    const space = spaces().find((s) => s.active);
    const spaceAgents = agents().filter((a) => !space || a.space === space.id);
    const targetAgent = spaceAgents.find((a) => a.focused) ?? spaceAgents[0];
    const targetFile = this.noteScope === "global" ? `${appHome()}/notes.md` : "NOTES.md";
    const prompt = `Please append a concise timestamped note (\`- **[YYYY-MM-DD HH:MM · Agent]** ...\`) to \`${targetFile}\` summarizing key findings, decisions, or open TODOs from our current session.`;
    if (!targetAgent) {
      this.noteStatus = "No active agent in this space";
      cx.notify();
      return;
    }
    this.noteStatus = `Asked ${targetAgent.title || targetAgent.program?.name || targetAgent.address} to update ${targetFile}`;
    cx.spawn(async (cx) => {
      try {
        await hc(["send", targetAgent.address, prompt]);
      } catch {}
      cx.notify();
    });
    cx.notify();
  }

  sendNotesToAgent(cx) {
    const space = spaces().find((s) => s.active);
    const spaceAgents = agents().filter((a) => !space || a.space === space.id);
    const targetAgent = spaceAgents.find((a) => a.focused) ?? spaceAgents[0];
    const targetFile = this.noteScope === "global" ? `${appHome()}/notes.md` : "NOTES.md";
    const prompt = `Please read \`${targetFile}\` and use the notes and action items recorded there to guide your next steps.`;
    if (!targetAgent) {
      this.noteStatus = "No active agent in this space";
      cx.notify();
      return;
    }
    this.noteStatus = `Sent ${targetFile} to ${targetAgent.title || targetAgent.program?.name || targetAgent.address}`;
    cx.spawn(async (cx) => {
      try {
        await hc(["send", targetAgent.address, prompt]);
        run("agent.focus", { terminal: targetAgent.address });
      } catch {}
      cx.notify();
    });
    cx.notify();
  }

  refresh(cx) {
    if (home() === "/fixture") return;
    const loc = activeLocation();
    this.lastCwd = loc.cwd;
    cx.spawn(async (cx) => {
      try {
        await this.loadNotes(loc);
        const script = `
          cwd="$1"
          # 1. Antigravity Brain artifacts (~/.gemini/antigravity-cli/brain & ~/.gemini/antigravity/brain)
          for bdir in "$HOME/.gemini/antigravity-cli/brain" "$HOME/.gemini/antigravity/brain"; do
            if [ -d "$bdir" ]; then
              ls -dt "$bdir"/* 2>/dev/null | head -n 12 | while IFS= read -r sdir; do
                [ -d "$sdir" ] || continue
                sid="\${sdir##*/}"
                short="\${sid:0:8}"
                in_ws="0"
                tlog="$sdir/.system_generated/logs/transcript.jsonl"
                if [ -n "$cwd" ] && [ "$cwd" != "$HOME" ] && [ -f "$tlog" ]; then
                  grep -Fq "$cwd" "$tlog" 2>/dev/null && in_ws="1"
                fi
                find "$sdir" -maxdepth 2 -type f \\( -name "*.md" -o -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.webp" -o -name "*.gif" -o -name "*.svg" \\) ! -path "*/.system_generated/*" ! -path "*/scratch/*" 2>/dev/null | head -n 25 | while IFS= read -r f; do
                  name="\${f##*/}"
                  printf "antigravity\\t%s\\t[%s] %s\\t%s\\n" "$in_ws" "$short" "$name" "$f"
                done
              done
            fi
          done
          # 2. Workspace Markdown, Docs & Agent Rules
          if [ -d "$cwd" ]; then
            for f in README.md NOTES.md AGENTS.md CLAUDE.md GEMINI.md PLAN.md TODO.md TASKS.md ARCHITECTURE.md .github/copilot-instructions.md; do
              [ -f "$cwd/$f" ] && printf "workspace\\t1\\t%s\\t%s\\n" "$f" "$cwd/$f"
            done
            if [ -d "$cwd/docs" ]; then
              find "$cwd/docs" -maxdepth 2 -type f -name "*.md" 2>/dev/null | sort | head -n 20 | while IFS= read -r p; do
                rel="\${p#$cwd/}"
                printf "workspace\\t1\\t%s\\t%s\\n" "$rel" "$p"
              done
            fi
            for d in "$cwd/.agents" "$cwd/.agent" "$cwd/.claude" "$cwd/.cursor/rules"; do
              if [ -d "$d" ]; then
                find "$d" -maxdepth 3 -type f \\( -name "*.md" -o -name "*.mdc" -o -name "*.json" \\) 2>/dev/null | head -n 20 | while IFS= read -r p; do
                  rel="\${p#$cwd/}"
                  printf "workspace\\t1\\t%s\\t%s\\n" "$rel" "$p"
                done
              fi
            done
          fi
          # 3. Claude Code plans (~/.claude/plans)
          if [ -d "$HOME/.claude/plans" ]; then
            ls -dt "$HOME/.claude/plans"/*.md 2>/dev/null | head -n 10 | while IFS= read -r md; do
              name="\${md##*/}"
              printf "claude\\t0\\t[Plan] %s\\t%s\\n" "$name" "$md"
            done
          fi
        `;
        const r = await exec("sh", ["-c", script, "brain-scan", loc.cwd], { on: loc.on });
        if (r.code === 0) {
          const seenPaths = new Set();
          const parsed = (r.stdout || "")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [kind, inWs, label, path] = line.split("\t");
              const ext = extOf(path);
              const isImage = IMG_EXTS.has(ext) && ext !== "svg" ? true : ext === "svg";
              return { kind, inSpace: inWs === "1", label, path, ext, isImage };
            })
            .filter((it) => {
              if (!it.path || seenPaths.has(it.path)) return false;
              seenPaths.add(it.path);
              return true;
            });

          // Sort: Active-space Antigravity artifacts first, then Workspace docs, then other Antigravity/Claude artifacts
          parsed.sort((a, b) => {
            const score = (x) =>
              (x.kind === "antigravity" && x.inSpace ? 40 : 0) +
              (x.kind === "workspace" ? 30 : 0) +
              (x.kind === "antigravity" ? 20 : 10) +
              (MD_EXTS.has(x.ext) ? 2 : 0);
            return score(b) - score(a);
          });

          this.items = parsed;
          if (!this.selected && parsed.length > 0) {
            await this.selectItem(parsed[0], loc.on, cx, false);
          } else if (this.selected) {
            const updated = parsed.find((p) => p.path === this.selected.path);
            if (updated) this.selected = updated;
            await this.selectItem(this.selected, loc.on, cx, true);
          }
        }
      } catch {}
      cx.notify();
    });
  }

  async selectItem(item, on, cx, quiet = false) {
    if (!item?.path) return;
    const changedFile = this.selected?.path !== item.path;
    this.selected = item;
    const ext = extOf(item.path);
    if (changedFile) {
      this.previewMode = true;
    }
    this.watchSelectedDir(dirName(item.path), on, cx);

    if (IMG_EXTS.has(ext) && ext !== "svg") {
      this.rawEditor?.release();
      this.rawEditor = null;
      this.content = "";
      return;
    }
    try {
      const text = await readTextFile(item.path, { on });
      const next = text ?? "";
      if (!quiet || next !== this.content || changedFile) {
        this.content = next;
        const t = theme();
        this.rawEditor?.release();
        this.rawEditor = EditorState.new({
          language: ext || "md",
          readonly: true,
          value: this.content.slice(0, 400000),
          font_family: settings().font_family,
          font_size: 12,
          syntax: {
            keyword: t.ansi5,
            string: t.ansi2,
            comment: t.dim,
            function: t.ansi4,
            type: t.ansi3,
            number: t.ansi1,
            constant: t.ansi6,
          },
        });
      }
    } catch {
      this.content = "_Unable to read file._";
    }
  }

  openPathInBrain(path, on, cx) {
    const existing = this.items.find((i) => i.path === path);
    const ext = extOf(path);
    const item = existing || {
      kind: "workspace",
      inSpace: true,
      label: baseName(path),
      path,
      ext,
      isImage: IMG_EXTS.has(ext),
    };
    cx.spawn(async (cx) => {
      await this.selectItem(item, on, cx, false);
      cx.notify();
    });
  }

  filteredItems() {
    if (this.filter === "space") return this.items.filter((i) => i.inSpace);
    if (this.filter === "antigravity") return this.items.filter((i) => i.kind === "antigravity");
    if (this.filter === "workspace") return this.items.filter((i) => i.kind === "workspace");
    if (this.filter === "images") return this.items.filter((i) => i.isImage);
    return this.items;
  }

  renderNotesSection(t, loc, cx) {
    const info = this.notePath(loc);
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .px(10)
          .py(8)
          .gap(7)
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .justify_between()
              .items_center()
              .gap(6)
              .child(
                h_flex()
                  .gap(4)
                  .children(
                    [
                      ["workspace", "Workspace NOTES.md"],
                      ["global", "Global Scratchpad"],
                    ].map(([id, label]) => {
                      const active = this.noteScope === id;
                      return div()
                        .id(`br-scope-${id}`)
                        .px(7)
                        .py(3)
                        .rounded(5)
                        .bg(active ? t.selected : t.raised)
                        .border(1)
                        .border_color(active ? t.accent : t.border)
                        .text_size(11)
                        .text_color(active ? t.foreground : t.muted)
                        .cursor_pointer()
                        .on_click((_e, cx) => {
                          this.noteScope = id;
                          this.editingNotes = false;
                          this.noteStatus = "";
                          cx.spawn(async (cx) => {
                            await this.loadNotes();
                            cx.notify();
                          });
                        })
                        .child(label);
                    }),
                  ),
              )
              .child(
                h_flex()
                  .gap(5)
                  .child(
                    div()
                      .id("br-note-edit-toggle")
                      .px(8)
                      .py(3)
                      .rounded(5)
                      .bg(this.editingNotes ? t.accent : t.raised)
                      .border(1)
                      .border_color(this.editingNotes ? t.accent : t.border)
                      .text_size(11)
                      .font_medium()
                      .text_color(this.editingNotes ? t.accent_foreground : t.foreground)
                      .cursor_pointer()
                      .on_click((_e, cx) => {
                        if (this.editingNotes) {
                          const draft = this.notesEditor.value();
                          this.editingNotes = false;
                          cx.spawn(async (cx) => {
                            await this.saveNotesText(draft, cx);
                          });
                        } else {
                          this.notesEditor.set_value(this.noteText);
                          this.editingNotes = true;
                          cx.notify();
                        }
                      })
                      .child(this.editingNotes ? "✓ Save" : "✎ Edit"),
                  )
                  .when(this.editingNotes, (el) =>
                    el.child(
                      div()
                        .id("br-note-cancel")
                        .px(7)
                        .py(3)
                        .rounded(5)
                        .bg(t.raised)
                        .text_size(11)
                        .text_color(t.muted)
                        .cursor_pointer()
                        .on_click((_e, cx) => {
                          this.editingNotes = false;
                          this.notesEditor.set_value(this.noteText);
                          cx.notify();
                        })
                        .child("Cancel"),
                    ),
                  ),
              ),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .child(
                    Input.new(this.quickInput)
                      .h(28)
                      .px(8)
                      .items_center()
                      .rounded(6)
                      .border(1)
                      .border_color(this.quickFocused ? t.accent : t.input)
                      .bg(t.background)
                      .text_size(11.5)
                      .text_color(t.foreground),
                  ),
              )
              .child(
                div()
                  .id("br-note-add")
                  .h(28)
                  .px(9)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .bg(t.accent)
                  .text_size(11.5)
                  .font_semibold()
                  .text_color(t.accent_foreground)
                  .cursor_pointer()
                  .on_click((_e, cx) => this.appendQuickNote(cx))
                  .child("+ Add"),
              ),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .gap(6)
                  .child(
                    div()
                      .id("br-agent-write-note")
                      .px(7)
                      .py(2)
                      .rounded(4)
                      .border(1)
                      .border_color(t.border)
                      .bg(t.background)
                      .text_size(10.5)
                      .text_color(t.muted)
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .cursor_pointer()
                      .tooltip("Ask the active agent in this space to append a summary/status note to NOTES.md")
                      .on_click((_e, cx) => this.askAgentToWriteNote(cx))
                      .child("🤖 Ask Agent to Note"),
                  )
                  .child(
                    div()
                      .id("br-agent-read-note")
                      .px(7)
                      .py(2)
                      .rounded(4)
                      .border(1)
                      .border_color(t.border)
                      .bg(t.background)
                      .text_size(10.5)
                      .text_color(t.muted)
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .cursor_pointer()
                      .tooltip("Tell the active agent to read NOTES.md and act on your notes")
                      .on_click((_e, cx) => this.sendNotesToAgent(cx))
                      .child("📤 Send Notes to Agent"),
                  ),
              )
              .child(div().text_size(10.5).text_color(t.dim).truncate().child(this.noteStatus || info.label)),
          ),
      )
      .child(
        div()
          .relative()
          .flex_1()
          .min_h(0)
          .when(this.editingNotes, (el) =>
            el.child(
              v_flex()
                .size_full()
                .p(10)
                .gap(8)
                .child(
                  Textarea.new(this.notesEditor)
                    .flex_1()
                    .w_full()
                    .p(10)
                    .rounded(7)
                    .border(1)
                    .border_color(t.accent)
                    .bg(t.background)
                    .text_color(t.foreground)
                    .text_size(12),
                ),
            ),
          )
          .when(!this.editingNotes, (el) =>
            el
              .child(
                v_flex()
                  .id("brain-notes-scroll")
                  .size_full()
                  .p(12)
                  .gap(8)
                  .overflow_y_scroll()
                  .when(!this.noteText.trim(), (sub) =>
                    sub.child(
                      div()
                        .text_size(12)
                        .text_color(t.dim)
                        .child(
                          `No notes in ${info.label} yet.\n\n• Type in the box above and press Enter to add a timestamped note.\n• Supports full Markdown, Mermaid diagrams (\`\`\`mermaid), and GitHub alerts (> [!NOTE]).\n• Click "🤖 Ask Agent to Note" to have your active coding agent write its findings into ${info.label}.`,
                        ),
                    ),
                  )
                  .when(Boolean(this.noteText.trim()), (sub) =>
                    sub.children(
                      renderRichMarkdown(t, this.noteText, "br-notes", this.docState, cx, {
                        baseDir: dirName(info.path),
                        filePath: info.path,
                        on: info.on,
                        onOpenPath: (p, cx) => {
                          this.mode = "artifacts";
                          this.openPathInBrain(p, loc.on, cx);
                        },
                      }),
                    ),
                  ),
              )
              .child(Scrollbar.vertical("brain-notes-scroll").absolute().inset_0()),
          ),
      );
  }

  renderArtifactBody(t, loc, cx) {
    if (!this.selected) {
      return div().p(12).text_color(t.dim).child("Select an artifact, plan, diagram, or image above to preview.");
    }
    const sel = this.selected;
    const ext = extOf(sel.path);
    const isBinaryImg = IMG_EXTS.has(ext) && ext !== "svg";
    const isSvg = ext === "svg";

    if (isBinaryImg || (isSvg && this.previewMode)) {
      const assetRel = ensureImageAsset(this.docState, sel.path, loc.on, cx);
      return v_flex()
        .id("brain-img-preview")
        .size_full()
        .p(14)
        .gap(10)
        .overflow_y_scrollbar()
        .items_center()
        .when(Boolean(assetRel), (el) => el.child(image(assetRel).max_w_full().rounded(8)))
        .when(!assetRel, (el) => el.child(div().p(12).text_color(t.dim).child("Staging image preview…")))
        .child(div().text_size(11).text_color(t.dim).child(sel.path));
    }

    if (!this.previewMode && this.rawEditor) {
      return Editor.new(this.rawEditor).flex_1().min_h(0);
    }

    return div()
      .relative()
      .flex_1()
      .min_h(0)
      .child(
        v_flex()
          .id("brain-preview")
          .size_full()
          .p(12)
          .gap(8)
          .overflow_y_scroll()
          .children(
            renderRichMarkdown(t, this.content || "", "br-art", this.docState, cx, {
              baseDir: dirName(sel.path),
              filePath: sel.path,
              on: loc.on,
              onOpenPath: (p, cx) => this.openPathInBrain(p, loc.on, cx),
            }),
          ),
      )
      .child(Scrollbar.vertical("brain-preview").absolute().inset_0());
  }

  renderArtifactsSection(t, loc, cx) {
    const shown = this.filteredItems();
    const sel = this.selected;
    const selExt = extOf(sel?.path);
    const canToggleRaw = Boolean(sel && (MD_EXTS.has(selExt) || selExt === "svg" || selExt === "json"));
    const badgeColor = (item) =>
      item.isImage ? t.ansi5 : item.kind === "antigravity" ? t.accent : item.kind === "claude" ? t.working : t.ansi2;

    const actionBtn = (id, label, tip, onClick) =>
      div()
        .id(id)
        .px(7)
        .py(2)
        .rounded(5)
        .bg(t.raised)
        .border(1)
        .border_color(t.border)
        .text_size(10.5)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .cursor_pointer()
        .tooltip(tip)
        .on_click(onClick)
        .child(label);

    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        // Filter bar
        h_flex()
          .px(8)
          .py(5)
          .gap(4)
          .flex_wrap()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .children(
            [
              ["all", `All (${this.items.length})`],
              ["space", "★ Space"],
              ["antigravity", "Antigravity"],
              ["workspace", "Docs"],
              ["images", "Images"],
            ].map(([fid, flabel]) => {
              const active = this.filter === fid;
              return div()
                .id(`br-flt-${fid}`)
                .px(7)
                .py(2)
                .rounded(5)
                .bg(active ? t.selected : "#00000000")
                .border(1)
                .border_color(active ? t.accent : t.border)
                .text_size(10.5)
                .text_color(active ? t.foreground : t.muted)
                .hover((s) => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
                .cursor_pointer()
                .on_click((_e, cx) => {
                  this.filter = fid;
                  cx.notify();
                })
                .child(flabel);
            }),
          ),
      )
      .child(
        // Artifacts list
        div()
          .relative()
          .h(148)
          .flex_none()
          .border_b(1)
          .border_color(t.border)
          .child(
            v_flex()
              .id("brain-list")
              .size_full()
              .p(6)
              .gap(2)
              .overflow_y_scroll()
              .when(shown.length === 0, (el) =>
                el.child(
                  div()
                    .p(8)
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child("No matching artifacts or Markdown documents found."),
                ),
              )
              .children(
                shown.map((item, idx) => {
                  const active = sel?.path === item.path;
                  const tag = item.isImage ? "img" : item.kind === "antigravity" ? "agy" : item.kind === "workspace" ? "doc" : item.kind;
                  return h_flex()
                    .id(`br-item-${idx}`)
                    .h(26)
                    .px(7)
                    .gap(6)
                    .rounded(5)
                    .items_center()
                    .cursor_pointer()
                    .bg(active ? t.selected : "#00000000")
                    .hover((s) => s.bg(active ? t.selected : t.hover))
                    .on_click((_e, cx) => {
                      cx.spawn(async (cx) => {
                        await this.selectItem(item, loc.on, cx, false);
                        cx.notify();
                      });
                    })
                    .child(
                      div()
                        .px(5)
                        .py(1)
                        .rounded(4)
                        .bg(t.raised)
                        .text_size(9.8)
                        .font_semibold()
                        .text_color(badgeColor(item))
                        .child(item.inSpace && item.kind === "antigravity" ? `★ ${tag}` : tag),
                    )
                    .child(
                      div()
                        .flex_1()
                        .truncate()
                        .text_size(11.8)
                        .text_color(active ? t.foreground : t.muted)
                        .child(item.label),
                    );
                }),
              ),
          )
          .child(Scrollbar.vertical("brain-list").absolute().inset_0()),
      )
      .when(Boolean(sel), (el) =>
        el.child(
          // Selected artifact toolbar (Preview/Raw, Split Right, Open as Tab, Expand Modal)
          h_flex()
            .px(10)
            .py(6)
            .gap(6)
            .items_center()
            .justify_between()
            .bg(t.chrome)
            .border_b(1)
            .border_color(t.border)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(11)
                .font_medium()
                .text_color(t.foreground)
                .truncate()
                .tooltip(sel?.path ?? "")
                .child(baseName(sel?.path)),
            )
            .child(
              h_flex()
                .gap(4)
                .items_center()
                .when(canToggleRaw, (sub) =>
                  sub.child(
                    actionBtn(
                      "brain-toggle-raw",
                      this.previewMode ? "</> Raw" : "◈ Preview",
                      "Toggle between rendered Markdown/Mermaid preview and raw source",
                      (_e, cx) => {
                        this.previewMode = !this.previewMode;
                        cx.notify();
                      },
                    ),
                  ),
                )
                .child(
                  actionBtn(
                    "brain-split-artifact",
                    "◫ Split",
                    "Open side-by-side beside the active terminal (live auto-reloading)",
                    () =>
                      run("pane.split", {
                        direction: "right",
                        mod: "files",
                        props: {
                          previewOnly: true,
                          previewFile: sel?.path,
                          previewRoot: "",
                          previewOn: loc.on,
                        },
                      }),
                  ),
                )
                .child(
                  actionBtn(
                    "brain-tab-artifact",
                    "⊞ Tab",
                    "Open artifact in its own full-size tab",
                    () =>
                      run("tab.new", {
                        name: baseName(sel?.path),
                        mod: "files",
                        props: {
                          previewOnly: true,
                          previewFile: sel?.path,
                          previewRoot: "",
                          previewOn: loc.on,
                        },
                      }),
                  ),
                )
                .child(
                  actionBtn("brain-expand-artifact", "⤢", "Open in large floating reader (Esc to close)", () =>
                    openOverlay({
                      mod: "files",
                      kind: "dialog",
                      width: 920,
                      height: 700,
                      props: {
                        modalPreview: true,
                        previewFile: sel?.path,
                        previewRoot: "",
                        previewOn: loc.on,
                      },
                    }),
                  ),
                ),
            ),
        ),
      )
      .child(div().relative().flex_1().min_h(0).flex().flex_col().child(this.renderArtifactBody(t, loc, cx)));
  }

  render(cx) {
    const t = theme();
    const loc = activeLocation();
    if (home() !== "/fixture" && loc.cwd !== this.lastCwd) {
      this.refresh(cx);
    }
    const space = spaces().find((s) => s.active);
    const spaceAgents = agents().filter((a) => !space || a.space === space.id);
    const allTerms = terminals();
    const childrenOf = (addr) => allTerms.filter((term) => term.parent === addr);

    return v_flex()
      .id("brain-panel")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .text_size(12.5)
      .child(
        // Top header with Artifacts / Notes mode switcher
        h_flex()
          .h(38)
          .px(10)
          .items_center()
          .justify_between()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(svg("mods/brain/brain.svg").size(14).text_color(t.accent))
              .children(
                [
                  ["artifacts", `Artifacts (${this.items.length})`],
                  ["notes", "Notes"],
                ].map(([id, label]) => {
                  const active = this.mode === id;
                  return div()
                    .id(`brain-mode-${id}`)
                    .px(8)
                    .py(3)
                    .rounded(5)
                    .bg(active ? t.selected : "#00000000")
                    .text_size(12)
                    .font_semibold()
                    .text_color(active ? t.foreground : t.muted)
                    .hover((s) => s.bg(active ? t.selected : t.hover).text_color(t.foreground))
                    .cursor_pointer()
                    .on_click((_e, cx) => {
                      this.mode = id;
                      setShared("brain.mode", id);
                      cx.notify();
                    })
                    .child(label);
                }),
              ),
          )
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(
                div()
                  .id("brain-refresh")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .text_size(11)
                  .text_color(t.muted)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .on_click((_e, cx) => this.refresh(cx))
                  .child("↻"),
              )
              .child(
                div()
                  .id("brain-close")
                  .size(22)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .text_color(t.dim)
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .cursor_pointer()
                  .on_click(() => run("layout.hide", { id: "panel" }))
                  .child(svg("mods/pane/close.svg").size(12)),
              ),
          ),
      )
      .when(spaceAgents.length > 0, (el) =>
        el.child(
          // Compact Active Space Agents strip
          v_flex()
            .px(10)
            .py(5)
            .gap(3)
            .border_b(1)
            .border_color(t.border)
            .children(
              spaceAgents.slice(0, 2).map((a) => {
                const kids = childrenOf(a.address);
                return h_flex()
                  .id(`br-ag-${a.address}`)
                  .px(6)
                  .py(2)
                  .gap(6)
                  .rounded(5)
                  .items_center()
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click(() => run("agent.focus", { terminal: a.address }))
                  .when(Boolean(a.program?.icon), (sub) =>
                    sub.child(
                      a.program.tint
                        ? svg(a.program.icon).size(12).text_color(t.foreground)
                        : image(a.program.icon).size(12),
                    ),
                  )
                  .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(a.title || a.program?.name || a.address))
                  .when(kids.length > 0, (sub) =>
                    sub.child(div().text_size(10).text_color(t.accent).child(`${kids.length} sub`)),
                  )
                  .child(
                    div()
                      .text_size(10)
                      .text_color(a.status === "blocked" ? t.blocked : a.status === "working" ? t.working : t.dim)
                      .child(a.status ?? "idle"),
                  );
              }),
            ),
        ),
      )
      .child(this.mode === "notes" ? this.renderNotesSection(t, loc, cx) : this.renderArtifactsSection(t, loc, cx));
  }
}
