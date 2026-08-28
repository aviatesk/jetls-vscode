---
name: changelog
description: >-
  Invoke before committing user-facing changes (new features, bug fixes,
  behavior changes) to update CHANGELOG.md. Skip for internal refactors, CI,
  docs-only, or minor dependency bumps.
---

# Updating CHANGELOG.md

## Format

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Line length

CHANGELOG.md is exempt from the 80-character Markdown line length rule because
it is used for GitHub release notes, where hard line breaks disrupt rendering.
For this reason it is also excluded from Prettier (see `.prettierignore`), whose
prose wrapping would otherwise reflow the entries.

That said, do not put everything on a single line unconditionally. Break lines
at natural points (sentence boundaries, after colons, etc.) when an entry is
long enough to benefit from it. Short, single-sentence entries are fine as one
line.

## Section structure

New entries go under the `## Unreleased` section. Use the following subsections
as needed (in this order):

- `### Announcement` -- important notices (always first if present)
- `### Added` -- new features
- `### Changed` -- changes to existing functionality
- `### Fixed` -- bug fixes

## Release metadata lines

The `- Commit:`, `- Diff:` and `- Pinned JETLS:` lines directly under a section
header are maintained by
[`scripts/prepare-release.sh`](../../../scripts/prepare-release.sh). Do not edit
or add them by hand.

## Entry style

- Start Added entries with "Added ..." and Fixed entries with "Fixed ...".
- Changed entries typically start with the component name.
- When closing a GitHub issue, append `(Closed <issue URL>)` using the absolute
  URL of the tracker where the issue lives: this repository for
  extension-specific issues (e.g.
  `https://github.com/aviatesk/jetls-vscode/issues/NNN`), or JETLS.jl for
  language-feature issues observed through this extension (e.g.
  `https://github.com/aviatesk/JETLS.jl/issues/NNN`).
- Use backticks for setting names, command names, and code elements.

## Entry content

Write entries from the user's perspective. Describe what changed in terms of
user-visible behavior — not implementation details.

- Don't include internal mechanisms (module structure, VSCode API specifics,
  process-management details) unless a user could reasonably observe or interact
  with them.
- The "why" of a fix rarely matters to users; the "what" of the new behavior
  does. If the prior behavior is worth mentioning, describe its user-visible
  symptom, not its cause.
