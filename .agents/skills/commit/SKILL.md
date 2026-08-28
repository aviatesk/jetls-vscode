---
name: commit
description: >-
  Use when writing a commit message, and MUST invoke before creating any git
  commit. Provides commit message format and safety rules.
---

# Message guideline

## Title format

Write the title as a brief summary in imperative mood, without a `component:`
prefix.

Examples:

- "Recover from a broken current generation"
- "Keep the spinner until the server is ready"
- "Update GitHub Actions workflows"

The history extracted from the JETLS.jl monorepo predates this rule and uses
`jetls-client:` (and other component) prefixes.

## Body

Write a body by default, including for small, self-contained changes. Do not
treat a descriptive title as a reason to omit the body. When little explanation
is needed, briefly state the motivation and implementation.

Organize body paragraphs in this order and omit any paragraph that is not
relevant:

1. Explain the concrete problem, limitation, or goal motivating the change.
   For user-facing work, describe the resulting capability or behavior. For
   internal work, explain the engineering reason without inventing a
   user-visible impact. Include a small code example when it adds clarity.
2. Explain the approach used to implement the change.
3. Mention important caveats, follow-up work, performance notes, or test
   coverage when relevant.

Write body paragraphs as explanatory prose with explicit subjects:

- Prefer a concrete subject such as the affected component or newly introduced
  type.
- Use `This change` or `This commit` when describing the patch as a whole.
- Use `The implementation` when explaining the mechanism.
- Do not omit a subject merely to avoid `we` or `I`.

Use backticks for code elements such as function names, variables, and paths.

## Line length

Ensure the maximum line length never exceeds 72 characters.
Never rely on Git or an editor to wrap the message automatically.

Before every commit, write the complete message to a uniquely named temporary
file with explicit line breaks, then commit with
`GIT_EDITOR=true git -c core.hooksPath=.githooks commit -F <message-file>`.
Do not use repeated `git commit -m` arguments for a multi-paragraph message.

The command-local `core.hooksPath` setting automatically runs the tracked
`commit-msg` hook and rejects lines longer than 72 characters.
Never use `--no-verify` to bypass it.

## GitHub references

When referencing external GitHub PRs or issues, use proper GitHub interlinking
format: "owner/repo#123".

## Co-author trailer

If you wrote code yourself, include a co-author trailer at the end of the
commit message, for example:

`Co-Authored-By: GPT-5.6 Sol <noreply@openai.com>`

Adjust the model name as appropriate. When simply asked to write a commit
message without having written the code, do not add the trailer.

## Examples

The examples below are from real history (predating the split out of the
monorepo, hence the `jetls-client` component); co-author trailers are
omitted.

### Feature addition

Reference: `8a8ece0a00451430db79173e6e0b981999eaacac`

```
jetls-client: Add completion for known `executable.env` keys

Editing the `env` object of `jetls-client.executable` offered no
completion for the environment variables the extension actually
honors, so users had to discover `JULIAUP_CHANNEL` and
`JULIA_APPS_JULIA_CMD` from the README prose.

This change enumerates the two variables as schema `properties` of
`env`, each with a `markdownDescription` (channel examples, the
executable-itself requirement on Windows, and the rule that
`JULIAUP_CHANNEL` is ignored when `JULIA_APPS_JULIA_CMD` is set) and
`minLength: 1`, so an empty string is flagged in `settings.json`
instead of failing at launch. `additionalProperties` stays, keeping
arbitrary environment variables valid; the enumeration only adds
completion and hover documentation. `JULIA_NUM_THREADS` is left out
deliberately, since the launch always passes `--threads=`, which
overrides it.

The first juliaup mention in each description surface now links to
the juliaup repository, matching the README.
```

### Bug fix

Reference: `0ff8fd41e307098d8381c6d719da41f17497dead`

```
jetls-client: Fix stale progress publication in the install step

The install progress notification's task callback runs asynchronously
inside `vscode.window.withProgress`. When the installation step failed
immediately (e.g. the generation directory could not be created), the
step's cleanup - which resets `installProgress` - could run before the
task callback, whose later `installProgress = progress` assignment
then republished a reference to the already-closed notification.
Subsequent progress messages of the same setup would report into that
dead notification instead of nowhere. The `onCancellationRequested`
listener was also never disposed.

The task callback now skips publishing when the step has already
ended, and the cancellation listener is disposed once the step's
`done` promise resolves.
```

# Safety guideline

See the ["Git operations" section in AGENTS.md][git-operations].

[git-operations]: ../../../AGENTS.md#git-operations
