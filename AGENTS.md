# Kestrel (`kestrel` / `herdr-app`)

**Kestrel** is a native GPUI desktop command center for coding agents and persistent terminals, built on top of [herdr-core](https://github.com/herdrdev/herdr-core) (`hc` / `kc`) and derived from [Herdr (`herdr-app`)](https://github.com/herdrdev/herdr-app) (Copyright 2025–2026 Can Çelik and the Herdr Contributors) under the Apache 2.0 License. See `NOTICE` and `THIRD-PARTY-NOTICES` for full attribution.

## Compatibility & Retained `herdr-core` Interfaces

To preserve full compatibility with `herdr-core`, remote SSH machines, and existing mods/data:
- **Background Engine:** `herdr-core` (`hc`, with `~/.local/bin/kc` linked as a convenience alias).
- **Terminal Labels:** `herdr.space`, `herdr.tab`, `herdr.seen`, `herdr.pinned`, `herdr.right-click`.
- **Mod Runtime API:** Mods import from `"herdr"` (`import { agents, spaces, hc, run, ... } from "herdr"`), typed in `herdr.d.ts`.
- **App Home:** Defaults to `~/.config/kestrel` (overridable via `KESTREL_HOME` or `HERDR_APP_HOME`; automatically migrates legacy `~/.config/herdr-app` on first launch).
- **CLI Binary:** Installed as `~/.local/bin/kestrel` (with `~/.local/bin/herdr-app` linked for backward compatibility).

## Guide for Agents (`defaults/AGENTS.md` & `src/SKILL.md`)

- `defaults/AGENTS.md` is written into `~/.config/kestrel/AGENTS.md` on every start so coding agents learn how to inspect and customize Kestrel.
- `cargo test` verifies that `defaults/AGENTS.md` documents every command in `src/commands.rs`, every setting in `src/settings.rs`, `CHANGELOG.md` matches `Cargo.toml` version, and `THIRD-PARTY-NOTICES` matches `licenses/inventory.json`.
- `kestrel --skill` (or `herdr-app --skill`) prints the window manual in `src/SKILL.md` (which keeps `# herdr-app:` header for `tests/skill.rs` compatibility).

## What Ships in `defaults/`

`defaults/` is embedded into Kestrel:
- **Mods:** `spaces`, `agents` (priority/grouped views, reboot session restore, smart `Ctrl+K` swarm & foreground approvals), `board` (2×2 Kanban Fleet Board, broadcast, central swarm approvals), `brain` + `files` (`doc-render.js`: Antigravity artifacts, GitHub callouts, carousels, split live-preview panes, and 6-type 2D Sugiyama vector SVG Mermaid diagrams), `tabs` + `terminals-bar` (window-adaptive top bar + cross-space running agents dropdown), `changes`, `worktree` (Arena mode), `workspace-chrome`, `workspace-status`, `menu`, `new-menu`, `peek`, `toast`, etc.
- **Layouts & Keys:** `layouts/main.json`, `layouts/board.json`, `layouts/terminals.json`, `layouts/win98.json`, `keys.json` (Linux/Windows), and `keys.macos.json` (macOS). Shipped layouts and mods are refreshed on start; personal clones created with `layout.clone` or `mod.clone` are preserved.

## Building, Testing & Installing

- `./scripts/install-macos` builds the release binary, packages and signs `~/Applications/Kestrel.app` (including `LICENSE`, `NOTICE`, and `THIRD-PARTY-NOTICES` in `Contents/Resources/`), and links `~/.local/bin/kestrel`, `~/.local/bin/herdr-app`, and `~/.local/bin/kc` -> `hc`.
- `cargo test` runs the full verification suite.
- Never run a bare `target/*/herdr-app` without arguments on a machine where you use Kestrel unless `HERDR_APP_HOME` points at a scratch directory; subcommands (`kestrel status`, `kestrel check`, `kestrel ls`, `--help`) only query the running instance.
- Never hardcode personal GCP project IDs, service account paths, or local user paths in repository files; runtime credentials belong exclusively in `~/.config/kestrel/shared.json`.
