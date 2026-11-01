# Licence inventory

Every licence that covers code shipped inside the MiniBots installer, and
every licence that covers code in the repository.

The inventory is checked by `scripts/verify-package.mjs`, which reads the
notices named here and confirms that every one of them is present in the
**built artifact**.

---

## The application itself

| Component | Version | Licence | Notice | Where |
|---|---|---|---|---|
| MiniBots (this port) | 0.1.0 | MIT | `LICENSE` | the repository root |
| The MiniMax Bot Mini App | 0.7.16 | MIT | `vendor/minimax-bot/LICENSE` | the vendored tree |
| Pi — `@earendil-works/pi-coding-agent` | 1.4.0 | MIT | `LICENSE` | inside the package's own directory |
| Pi — `@earendil-works/pi-ai` | 1.4.0 | MIT | `LICENSE` | inside the package's own directory |

The MiniMax Bot Mini App is a **derived work**: the upstream tree is imported
whole, its licence file is preserved unmodified, and every change made to it
is listed in `vendor/minimax-bot/MODIFICATIONS.md`. The upstream's original
notice therefore still covers the derived work.

---

## The Electron runtime

| Component | Version | Licence | Where |
|---|---|---|---|
| Electron | 45.1.0 | MIT | `node_modules/electron/LICENSE` |
| Chromium | 156.0.8078.48 | BSD-3-Clause | `node_modules/electron/dist/LICENSES.chromium.html` |
| Node.js | 24.22.1 (embedded) | MIT | `node_modules/electron/dist/LICENSES.node.txt` |

Electron ships its own licence texts inside the installed application, under
`resources/licenses/`.

---

## The Pi runtime, in full

Pi 1.4.0 depends on these packages, all of which are shipped inside the
application's archive:

| Package | Licence |
|---|---|
| `@earendil-works/pi-agent-core` | MIT |
| `@earendil-works/pi-ai` | MIT |
| `@earendil-works/pi-codemode` | MIT |
| `@earendil-works/pi-coding-agent` | MIT |
| `@earendil-works/pi-mcp` | MIT |
| `@earendil-works/pi-telemetry` | MIT |
| `@earendil-works/pi-tui` | MIT |

Pi's own transitive dependencies are shipped too, and each keeps its own
licence file inside its own package directory. The full inventory of what is
shipped is the `node_modules` tree itself, and `scripts/verify-package.mjs`
confirms that every package in it carries a licence notice.

---

## The build tooling — not shipped

These are used to build MiniBots and are **not** part of the installer:

| Package | Version | Licence |
|---|---|---|
| `electron-builder` | 26.0.12 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `@types/node` | 24.10.1 | MIT |

---

## The appearance assets

The eleven bot skins — `bubble`, `fuzzy`, `glass`, `gold`, `jade`, `moon`,
`pixel`, `plush`, `smiley`, `toys`, `waffle` — are part of the upstream Mini
App and are covered by its MIT licence. They are preserved byte-for-byte;
`scripts/verify-upstream.mjs` reports **client files changed: 0**.

The app's own icon and tray icon are derived from the upstream `fuzzy` skin,
so they are covered by the same licence. See `scripts/make-icons.mjs`.
