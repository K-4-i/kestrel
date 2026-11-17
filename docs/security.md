# Security and privacy

## Mods have your access

A mod is trusted JavaScript running inside Kestrel. It can run programs with your environment, fetch URLs and read files.
The built-in file API limits writes to the app home, but a mod can run a program to write elsewhere. That is not a security boundary.
Mods can also run programs on connected machines.

There is no permission prompt for each program or network request from a UI mod. Read a mod before installing it, and treat it like a shell script you would run yourself.
Layouts can load mods. Check those references too.

## What stays on disk

The default app home is `~/.config/kestrel`, including on macOS and Windows (under your user home). If upgrading from an older install, Kestrel automatically migrates legacy `~/.config/herdr-app` data on first launch.
`XDG_CONFIG_HOME` changes the config root. `KESTREL_HOME` (or `HERDR_APP_HOME`) selects an app home directly and takes precedence.

This folder holds your settings, keys, layouts, mods, generated agent guide and API types.
It also holds mod data, shared state (`shared.json`, including your personal Vertex AI configuration), window positions, and this screen's focus and zoom.
Kestrel does not encrypt this folder.
The [installed guide's file map](../defaults/AGENTS.md#the-files) explains the files.

Spaces, tabs and splits are stored in each machine's `herdr-core` document, not in the app home.
Terminals and their output belong to [herdr-core](https://github.com/herdrdev/herdr-core).
Removing the app home does not stop the core or erase its data.

The app exposes a local control socket in its home so agents can inspect and drive the window (`kestrel status`, `kestrel do`).
Treat access to that home as access to the window and its commands.
Remote connections use SSH through `herdr-core`.

## Telemetry & Network Privacy

Outbound usage telemetry and automatic release-service polling are **disabled** in Kestrel.
Kestrel does not phone home or transmit usage reports.

[Back to Kestrel](../README.md)
