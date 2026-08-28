# Development

This repository contains `jetls-client`, the VSCode language client
extension for [JETLS](https://github.com/aviatesk/JETLS.jl).

## Development setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the extension:
   ```bash
   npm run build
   ```
   Or for development with watch mode:
   ```bash
   npm run build:watch
   ```

## Testing the extension locally

To test the extension locally in VSCode:

1. Open this repository in VSCode
2. Press F5 to launch the Extension Development Host
3. The extension will be loaded in the new VSCode window

Without an explicit `jetls-client.executable` setting, the development
extension uses the production managed default and installs the release
tag pinned in [`JETLS_VERSION.json`](./JETLS_VERSION.json).
It does not run a local JETLS checkout.

To use a local JETLS.jl checkout with the development extension (see
[Using local JETLS checkout](https://github.com/aviatesk/JETLS.jl/blob/master/DEVELOPMENT.md#using-local-jetls-checkout)),
explicitly configure `jetls-client.executable` in your `settings.json`
using the array form:
```jsonc
{
  "jetls-client.executable": [
    "julia",
    "--startup-file=no",
    "--history-file=no",
    "--project=/path/to/JETLS",
    "-m",
    "JETLS",
    "serve"
  ]
}
```

The array form is a full custom command and bypasses managed
installation. To use an already installed custom executable instead,
specify `path` explicitly:

```jsonc
{
  "jetls-client.executable": {
    "path": "/absolute/path/to/jetls",
    "threads": "auto"
  }
}
```

An object that omits `path` continues to use the managed installation.

## Configuration schema sync

The generated blocks of [`package.json`](./package.json) (the
`jetls-client.settings` properties and the
`jetls-client.initializationOptions` schema) are not edited by hand:
they are defined by the config structs in the JETLS server and synced
from the `vscode-configuration.json` asset published on the pinned
JETLS release with [`sync-schemas.mjs`](./sync-schemas.mjs):

```bash
npm run sync-schemas
```

`node sync-schemas.mjs --check` verifies `package.json` is in sync
(CI runs this), and `--from FILE` reads the asset from a local file
(e.g. a JETLS checkout's `schemas/vscode-configuration.json`) instead
of downloading it. Pin bumps performed by
[`scripts/prepare-release.sh`](./scripts/prepare-release.sh) `--pin`
re-run the sync automatically.

## Publishing

The managed default installs the JETLS release tag pinned in
[`JETLS_VERSION.json`](./JETLS_VERSION.json), which also records the
supported Julia version bounds. The bounds must mirror the pinned
release's `julia` compat entry in `Project.toml`, which is expected to
stay in the `<lower> - <upper>` hyphen-range form; the release script
and CI check the pinned tag and this correspondence automatically.

Extension versions use the release date as `YYYY.M.D` (e.g.
`2026.8.23`), mirroring the date-based JETLS server releases the
extension pins. The Marketplace requires semver, which rejects leading
zeros, so the month and day are not zero-padded; the version therefore
only approximates the `YYYY-MM-DD` form of the server pin, and
`JETLS_VERSION.json` remains the authoritative pairing. Versions
released before this scheme used semver (`0.8.0` and earlier); the
calendar versions sort after them, so updates keep flowing.

To release the extension:

1. Prepare the release branch and pull request:
   ```bash
   ./scripts/prepare-release.sh [--pin YYYY-MM-DD] YYYY.M.D
   ```
   The script branches `releases/vYYYY.M.D` off `origin/master`,
   optionally updates the pin in `JETLS_VERSION.json` (re-syncing the
   `package.json` schemas from the pinned release), validates that the
   pinned release tag exists, sets the version in
   [`package.json`](./package.json) and
   [`package-lock.json`](./package-lock.json), renames the
   [`CHANGELOG.md`](./CHANGELOG.md) `Unreleased` section to the
   release version (recording the pinned JETLS release in it and
   re-creating an empty `Unreleased` section), updates the version
   placeholder in the
   [bug-report issue template](./.github/ISSUE_TEMPLATE/bug-report.yml),
   creates the `release: vYYYY.M.D` commit, and opens a pull request
   against `master`. Use `--no-push` to prepare the branch locally
   without pushing or opening the PR.

   After a JETLS server release, this step runs automatically:
   [`server-release.yml`](./.github/workflows/server-release.yml)
   receives a `repository_dispatch` event from the JETLS.jl release
   workflow and runs the script with `--pin` set to the new server
   release and the client version derived from its date, so the
   release PR appears without manual work. The workflow can also be
   started manually via `workflow_dispatch` with the server version
   as input.
2. Wait for CI to pass on the pull request. The regular checks run on
   it, and [`release.yml`](./.github/workflows/release.yml) verifies
   the release invariants: the branch name matches `package.json` and
   the CHANGELOG, the pinned server release exists, and the release
   tag is not taken yet.
3. Merge the pull request. The merge triggers the publish workflow,
   which packages the extension, publishes it to the Marketplace,
   pushes the `vYYYY.M.D` tag, and creates the GitHub release with the
   packaged `.vsix` attached. The release branch can be deleted after
   merging.

Publishing authenticates with the `VSCE_PAT` repository secret: an
Azure DevOps personal access token with the Marketplace "Manage"
scope. The token has an expiry and must be rotated before it lapses.
The automated PR flow additionally needs the `RELEASE_PR_TOKEN`
secret: a GitHub personal access token with `contents` and
`pull-requests` write access to this repository, since pushes and pull
requests created with the default workflow token do not trigger CI.
The same token is stored in the JETLS.jl repository to send the
`repository_dispatch` event after server releases.
