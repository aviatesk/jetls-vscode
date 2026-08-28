# Repository overview

This repository contains `jetls-client`, the VSCode client extension for
[JETLS](https://github.com/aviatesk/JETLS.jl).
[DEVELOPMENT.md](./DEVELOPMENT.md) describes the development workflows:
setup, testing the extension locally, the configuration schema sync, and
the release process. Consult it before working on those areas.

# Formatting

## Code formatting

- When writing TypeScript or JavaScript code, use _2 whitespaces_ for
  indentation and double quotes for strings, and try to keep the maximum
  line length under _80 characters_.
- AI agents must not run automated formatters unless explicitly requested by a
  human in the current conversation.
  This includes file-wide or project-wide formatting commands and
  editor-integrated formatting tools.
  When editing code, preserve the surrounding formatting and make only minimal
  local edits. If formatting seems necessary, ask before applying it.

## File names

For file names, use `-` (hyphen) as the word separator.

## Markdown formatting

When writing Markdown text, use _2 whitespaces_ for indentation and try to
keep the maximum line length under _80 characters_.
- Exception: [`CHANGELOG.md`](./CHANGELOG.md) is exempt from line length
  rules since it is used for GitHub release notes, where hard line breaks
  disrupt rendering.
- Additionally, prioritize simple text style and limit unnecessary decorations
  (e.g. `**`) to only truly necessary locations. This is a style that should
  generally be aimed for, but pay particular attention when writing Markdown.
- Headers should use sentence case (only the first word capitalized), not
  title case. For example:
  - Good: `## Conclusion and alternative approaches`
  - Bad: `## Conclusion And Alternative Approaches`

## Commit message formatting

When writing commit messages, follow the format "component: Brief summary" for
the title.

In the body, write paragraphs in this order:

1. Explain the concrete problem or user-visible limitation being fixed.
   If appropriate, include a small code example when it makes the issue
   clearer.
2. Explain the approach used to fix the problem.
3. Mention important caveats, follow-up work, performance notes, or test
   coverage when relevant.

Use backticks for code elements (function names, variables, file paths, etc.)
to improve readability.

Ensure that the maximum line length never exceeds 72 characters.
When referencing external GitHub PRs or issues, use proper GitHub interlinking
format (e.g., "owner/repo#123" for PRs/issues).
Finally, if you write code yourself, include a co-author trailer at the end
of the commit message, e.g.: `Co-Authored-By: GPT-5.6 <noreply@openai.com>`
(adjust the model name as appropriate). However, when simply asked to write
a commit message, there's no need to add that trailer.

# Coding rules

## Updating `package.json` and `JETLS_VERSION.json`

These files participate in the release process and parts of them are
generated; consult [DEVELOPMENT.md](./DEVELOPMENT.md) before editing them.

- [`package.json`](./package.json) contains generated configuration blocks
  (the `properties` of `jetls-client.settings` and the
  `jetls-client.initializationOptions` schema): they mirror the JETLS
  server's config structs. Never edit them by hand; when they need
  updating, follow the
  [schema sync procedure](./DEVELOPMENT.md#configuration-schema-sync).

- When touching [`JETLS_VERSION.json`](./JETLS_VERSION.json), keep the
  julia bounds mirroring the pinned JETLS release's `julia` compat entry,
  as described in [Publishing](./DEVELOPMENT.md#publishing); CI and the
  release script check this correspondence.

## Comments guideline

Default to no comments. Add comments only when they explain non-obvious
behavior, constraints, invariants, rationale, or genuine hacks. Do not restate
implementation flow.

The same applies to tests: behavior-level comments are fine when they clarify
what is being tested. Explain test setup only when it encodes a non-obvious
constraint or hack.

# Running checks

Please make sure to run the checks after writing or modifying code:

```bash
npm run check
```

This runs the TypeScript compiler, ESLint, and the
[`package.json`](./package.json) schema validation. It is run in CI and
will cause failures if new problems are introduced.

# Running test

Please make sure to test new code when you wrote:

```bash
npm test
```

Tests use the Node.js built-in test runner (`node:test`), live in
`test/*.test.ts`, and are built and run via
[`test-runner.mjs`](./scripts/test-runner.mjs).

# About modifications to code you've written

If the user manually changes work you previously produced, respect those
changes. Do not reintroduce deleted code or revert user edits without explicit
permission. If you think a user edit is problematic, explain your concern and
ask for clarification.

# Git operations

Only perform a Git operation that modifies repository state when the user
explicitly requests it. Treat each such request as authorization for one write
operation: after completing it, do not perform another write operation until
the user explicitly requests one. Read-only Git operations and other
non-mutating work may continue in the meantime.

If the user provides feedback on a commit, do not automatically amend it or
create a fixup commit. Explain what could change and wait for explicit
instruction.
