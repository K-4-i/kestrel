// Modified by Kestrel Contributors (2026) from upstream Herdr (herdr-app, Apache-2.0). See NOTICE.
// A lazy file browser and live Rich Markdown / Mermaid / Artifact viewer for Kestrel.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, Editor, EditorState } from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  run,
  openOverlay,
  closeOverlay,
  props,
  readTextFile,
  watchFolder,
  home,
  theme,
  settings,
  window,
} from "herdr";
import {
  MD_EXTS,
  IMG_EXTS,
  extOf,
  createDocState,
  ensureImageAsset,
  renderRichMarkdown,
} from "./doc-render.js";

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}

const key = () => JSON.stringify(location());
const LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
};
const PER_FOLDER = 500;
const TOTAL = 5000;

function dirName(p) {
  if (!p) return "";
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "/";
}

function baseName(p) {
  return (p || "").split(/[\\/]/).pop() || "";
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" +
          path.replace(/['‘’‚‛]/g, "$&$&") +
          "'",
      ],
      { on },
    );
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "files", path], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    const p = props() || {};
    this.isModal = Boolean(p.modalPreview);
    this.isPreviewOnly = Boolean(p.previewOnly);
    this.isFixedPreview = this.isModal || this.isPreviewOnly;
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.previewMode = true;
    this.rawText = "";
    this.docState = createDocState();
    this.history = [];

    if (this.isFixedPreview && p.previewFile) {
      this.root = p.previewRoot || "";
      this.on = p.previewOn ?? null;
      this.context = { key: "fixed-preview", cwd: this.root, on: this.on };
      this.show(p.previewFile, cx);
      if (this.isPreviewOnly && home() !== "/fixture") {
        const full = p.previewFile.startsWith("/") ? p.previewFile : `${this.root}/${p.previewFile}`;
        this.watchPreviewFile(dirName(full), cx);
        cx.timer.every(5000, (cx) => {
          if (this.file) this.reloadCurrentFile(cx);
        });
      }
      return;
    }

    this.refresh(cx);
    if (home() !== "/fixture") {
      cx.timer.every(10000, (cx) => this.refresh(cx));
    }
  }

  watchPreviewFile(dir, cx) {
    if (home() === "/fixture" || this.on || !dir || this.watchedPreviewDir === dir) return;
    this.watchedPreviewDir = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watchedPreviewDir === dir) {
          await watchFolder(dir);
          if (this.watchedPreviewDir === dir && this.file) {
            this.reloadCurrentFile(cx);
          }
        }
      } catch {
        if (this.watchedPreviewDir === dir) this.watchedPreviewDir = null;
      }
    });
  }

  reloadCurrentFile(cx) {
    if (!this.file || !cx) return;
    const ext = extOf(this.file);
    if (IMG_EXTS.has(ext) && ext !== "svg") return;
    const fullPath = this.file.startsWith("/") ? this.file : `${this.root}/${this.file}`;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(fullPath, { on: this.on });
        if (text === null || text.includes("\0")) return;
        const next = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (next !== this.rawText) {
          this.rawText = next;
          const t = theme();
          this.code?.release();
          this.code = EditorState.new({
            language: LANG[ext] ?? (ext || "txt"),
            readonly: true,
            value: this.rawText,
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
          cx.notify();
        }
      } catch {}
    });
  }

  watch(root, cx) {
    if (home() === "/fixture" || this.on || this.watched === root || this.isFixedPreview) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.current(context)) {
            this.refresh(cx);
            if (this.file) this.reloadCurrentFile(cx);
          }
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
    });
  }

  current(context) {
    if (this.isFixedPreview) return true;
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
    );
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (this.isFixedPreview) return;
    const { cwd, on } = location();
    const next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.show(null);
      this.watched = null;
      this.error = null;
      this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec(
            "git",
            ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
            { cwd, on },
          ).catch(() => null);
          if (status?.code === 0) {
            for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
                xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, pushHistory = false) {
    if (pushHistory && this.file && path && this.file !== path) {
      this.history.push(this.file);
    }
    this.code?.release();
    this.code = null;
    this.file = path;
    this.fileError = null;
    this.rawText = "";
    this.docState.mermaidRaw.clear();
    if (!path || !cx) return;
    const ext = extOf(path);
    const fullPath = path.startsWith("/") ? path : `${this.root}/${path}`;
    if (this.isPreviewOnly) {
      this.watchPreviewFile(dirName(fullPath), cx);
    }
    this.previewMode = MD_EXTS.has(ext) || IMG_EXTS.has(ext);
    if (IMG_EXTS.has(ext) && ext !== "svg") {
      cx.notify();
      return;
    }
    const context = this.context;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(fullPath, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) {
          this.fileError = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.fileError = "Binary file · no text preview";
          return;
        }
        this.rawText = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        const t = theme();
        this.code = EditorState.new({
          language: LANG[ext] ?? (ext || "txt"),
          readonly: true,
          value: this.rawText,
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
      } catch {
        if (this.file === path && this.current(context)) {
          this.fileError = "Cannot preview this file (binary, too large, or unreadable)";
        }
      } finally {
        cx.notify();
      }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      const mark = this.marks[`${this.root}/${path}`];
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
          .child(
            entry.dir
              ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim)
              : div().w(12).flex_none(),
          )
          .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), (el) =>
            el.child(
              div()
                .text_size(11)
                .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)
                .child(mark),
            ),
          ),
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  renderFileView(t, cx) {
    const ext = extOf(this.file);
    const fullPath = this.file?.startsWith("/") ? this.file : `${this.root}/${this.file}`;
    const isBinaryImg = IMG_EXTS.has(ext) && ext !== "svg";
    const isSvg = ext === "svg";

    if (isBinaryImg || (isSvg && this.previewMode)) {
      const assetRel = ensureImageAsset(this.docState, fullPath, this.on, cx);
      return v_flex()
        .id("files-img-preview")
        .flex_1()
        .min_h(0)
        .p(16)
        .overflow_y_scrollbar()
        .items_center()
        .gap(10)
        .when(Boolean(assetRel), (el) => el.child(image(assetRel).max_w_full().rounded(8)))
        .when(!assetRel, (el) => el.child(div().p(12).text_color(t.dim).child("Loading image preview…")))
        .child(div().text_size(11.5).text_color(t.dim).child(fullPath));
    }
    if (this.fileError) {
      return div().p(12).text_color(t.dim).child(this.fileError);
    }
    if (!this.code) {
      return div().p(12).text_color(t.dim).child("Loading file…");
    }
    if (this.previewMode && MD_EXTS.has(ext)) {
      return div()
        .relative()
        .flex_1()
        .min_h(0)
        .child(
          v_flex()
            .id("files-md-preview")
            .size_full()
            .p(16)
            .gap(10)
            .overflow_y_scroll()
            .children(
              renderRichMarkdown(t, this.rawText, "files-doc", this.docState, cx, {
                baseDir: dirName(fullPath),
                filePath: fullPath,
                rootDir: this.root,
                on: this.on,
                isModal: this.isModal,
                onOpenPath: (targetPath, cx) => this.show(targetPath, cx, true),
              }),
            ),
        )
        .child(Scrollbar.vertical("files-md-preview").absolute().inset_0());
    }
    return Editor.new(this.code).flex_1().min_h(0);
  }

  render(cx) {
    if (!this.isFixedPreview && key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const ext = extOf(this.file);
    const canPreview = Boolean(this.file && (MD_EXTS.has(ext) || ext === "svg"));
    const fullFile = this.file ? (this.file.startsWith("/") ? this.file : `${this.root}/${this.file}`) : "";
    const h = home();
    const prettyFullFile = fullFile && h && fullFile.startsWith(`${h}/`) ? `~${fullFile.slice(h.length)}` : fullFile;

    return v_flex()
      .id("files")
      .size_full()
      .min_h(0)
      .when(!this.isPreviewOnly, (el) => el.rounded(10).border_1().border_color(t.border))
      .overflow_hidden()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .bg(this.isPreviewOnly ? t.chrome : t.background)
          .border_b(1)
          .border_color(t.border)
          .when(Boolean((this.file && !this.isFixedPreview) || this.history.length > 0), (el) =>
            el.child(
              div()
                .id("files-back")
                .w(22)
                .cursor_pointer()
                .text_color(t.muted)
                .hover((s) => s.text_color(t.foreground))
                .tooltip("Back")
                .on_click((_e, cx) => {
                  if (this.history.length > 0) {
                    const prev = this.history.pop();
                    this.show(prev, cx, false);
                  } else {
                    this.show(null);
                    cx.notify();
                  }
                })
                .child("←"),
            ),
          )
          .child(
            div()
              .font_semibold()
              .child(this.isModal ? "Preview" : this.isPreviewOnly ? baseName(this.file) || "Artifact" : "Files"),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_right()
              .text_size(11.5)
              .text_color(t.dim)
              .tooltip(prettyFullFile || this.root || "")
              .child(this.isPreviewOnly ? prettyFullFile : (this.file ?? this.root?.split(/[\\/]/).pop() ?? "")),
          )
          .when(canPreview, (el) =>
            el.child(
              div()
                .id("files-preview-toggle")
                .px(8)
                .py(2)
                .rounded(5)
                .bg(this.previewMode ? t.selected : t.raised)
                .border(1)
                .border_color(this.previewMode ? t.accent : t.border)
                .text_size(11)
                .text_color(t.foreground)
                .cursor_pointer()
                .on_click((_e, cx) => {
                  this.previewMode = !this.previewMode;
                  cx.notify();
                })
                .child(this.previewMode ? "</> Raw" : "◈ Preview"),
            ),
          )
          .when(Boolean(this.file && !this.isModal && !this.isPreviewOnly), (el) =>
            el.child(
              div()
                .id("files-split-pane")
                .px(7)
                .py(2)
                .rounded(5)
                .bg(t.raised)
                .border(1)
                .border_color(t.border)
                .text_size(11)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .tooltip("Open side-by-side beside active terminal (live auto-reloading)")
                .on_click(() =>
                  run("pane.split", {
                    direction: "right",
                    mod: "files",
                    props: {
                      previewOnly: true,
                      previewFile: fullFile,
                      previewRoot: "",
                      previewOn: this.on,
                    },
                  }),
                )
                .child("◫ Split"),
            ),
          )
          .when(Boolean(this.file && !this.isModal), (el) =>
            el.child(
              div()
                .id("files-expand-modal")
                .px(7)
                .py(2)
                .rounded(5)
                .bg(t.raised)
                .border(1)
                .border_color(t.border)
                .text_size(11)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .tooltip("Open in large preview window (Esc to close)")
                .on_click(() =>
                  openOverlay({
                    mod: "files",
                    kind: "dialog",
                    width: 920,
                    height: 700,
                    props: {
                      modalPreview: true,
                      previewFile: fullFile,
                      previewRoot: "",
                      previewOn: this.on,
                    },
                  }),
                )
                .child("⤢"),
            ),
          )
          .when(!this.isPreviewOnly, (el) =>
            el.child(
              div()
                .id("files-close")
                .px(6)
                .py(2)
                .rounded(4)
                .text_size(12)
                .text_color(t.muted)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .cursor_pointer()
                .tooltip(this.isModal ? "Close preview (Esc)" : "Close panel (Cmd+Shift+A)")
                .on_click(() => {
                  if (this.isModal && props()?.overlay) closeOverlay(props().overlay);
                  else run("layout.hide", { id: "panel" });
                })
                .child("×"),
            ),
          ),
      )
      .when(!this.file, (el) =>
        el.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(6)
            .children(this.rows("", 0, [], t))
            .when(Boolean(this.error) || !this.entries.get("")?.length, (sub) =>
              sub.child(
                div()
                  .p(8)
                  .text_size(12)
                  .text_color(t.dim)
                  .child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder")),
              ),
            )
            .when(this.limited, (sub) =>
              sub.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")),
            ),
        ),
      )
      .when(Boolean(this.file), (el) => el.child(this.renderFileView(t, cx)));
  }
}
