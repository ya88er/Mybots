# Upstream: MiniBots (MiniMax Bot Mini App)

This directory contains an unmodified import of the upstream MiniBots Mini App
plugin subtree. It is the starting point for the Windows desktop port.

## Source

| Field | Value |
|---|---|
| Repository | <https://github.com/MiniMax-AI/MiniMax-Code-MiniApps> |
| Pinned commit | `79ebc4b89be6b372365199db92d69e5e36ac3409` |
| Subtree path | `plugins/minimax-ai/minimax-bot` |
| Package | `minimax-bot` |
| Package version | `0.7.16` |
| Upstream license | MIT (see `LICENSE` in this directory) |
| Import date | 2026-11-01 |
| Imported by | `scripts/import-upstream.mjs` |

## Import integrity

The import copied **89 files** (2,663,241 bytes) including dotfile directories
(`.minimax-plugin/`) and binary assets (`icon.png`, 11 skin PNGs). The upstream
`LICENSE`, `README.md`, `servers.mcp.json`, and `package.json` are preserved
verbatim.

Re-running the importer is idempotent and produces a byte-identical tree from
the same pinned commit.

## License and attribution

The upstream work is MIT-licensed, with MiniMax attribution. The original
`LICENSE` file is kept in this directory unmodified. This port is a derived
work and retains the upstream notices.

Files under this directory that have been modified by the port are listed in
`MODIFICATIONS.md`.

## Pinned baseline

The commit above is the acceptance baseline, even if upstream advances during
implementation. New upstream commits are **not** pulled in implicitly; adopting
one is a deliberate, separately-reviewed change that re-runs the full upstream
test suite.
