# Layouts and mods

You can change the whole Kestrel window, not just its colors. Layouts arrange it; mods draw the panels inside it.

Read the [layout and mod guide](../defaults/AGENTS.md). This is the same guide Kestrel writes into your app home (`~/.config/kestrel/AGENTS.md`) on every start, so people and agents work from one source of truth.
It covers layouts, settings, keys, overlays, mod code and the app API.
The generated `herdr.d.ts` and `gpui-kit.d.ts` beside your installed guide describe the full API for your version.

Start with Settings for fonts, colors, Vertex AI (`Cmd+Shift+V`), and alerts.
For deeper changes, duplicate a shipped layout or mod from the command palette, then edit the copy.
Shipped files update on start; personal copies do not.
Save to reload. Check for errors, even when the old screen still looks fine.

```sh
kestrel check ~/.config/kestrel/mods/my-panel
kestrel status
```

The check loads a mod and renders it once. It does not replace looking at the result in the window.

Mods can run programs, read files and use the network. Only install code you trust.
See [security and privacy](security.md).

[Back to Kestrel](../README.md)
