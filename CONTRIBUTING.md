# Contributing to Kestrel

Kestrel is designed to be customized live by you and your coding agents through layouts (`layouts/*.json`) and mods (`mods/<name>/main.js`).

## Building & Testing

See [README.md](README.md#getting-kestrel-macos-apple-silicon) for setup.
- Build and install on macOS: `./scripts/install-macos`
- Check a mod: `kestrel check ~/.config/kestrel/mods/<name>`
- Run unit tests: `cargo test --locked`

## Attribution & Licenses

Kestrel is a derivative work of [Herdr (`herdr-app`)](https://github.com/herdrdev/herdr-app) and uses [`herdr-core`](https://github.com/herdrdev/herdr-core), both licensed under the Apache License, Version 2.0. See [NOTICE](NOTICE) and [licenses/README.md](licenses/README.md).
