// Syncs the generated configuration blocks in package.json from the
// `vscode-configuration.json` asset published on the pinned JETLS release
// (`JETLS_VERSION.json`). The asset's `settings` replaces the `properties`
// of `jetls-client.settings`; its `initializationOptions` is merged into
// the `jetls-client.initializationOptions` property object, preserving the
// hand-written keys that only live in package.json (`scope`, `default`,
// `order`).
//
// Usage: node scripts/sync-schemas.mjs [--check] [--from FILE]
//   --check      Verify package.json is up to date instead of writing
//   --from FILE  Read the asset from FILE instead of downloading it

import fs from "node:fs";
import process from "node:process";

const JETLS_REPOSITORY = "aviatesk/JETLS.jl";
const ASSET_NAME = "vscode-configuration.json";

const args = process.argv.slice(2);
const checkMode = args.includes("--check");
const fromIndex = args.indexOf("--from");
const fromFile = fromIndex === -1 ? null : args[fromIndex + 1];
if (fromIndex !== -1 && !fromFile) {
  console.error("Error: --from requires a file path");
  process.exit(1);
}

const packageJsonUrl = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(
  fs.readFileSync(new URL("../JETLS_VERSION.json", import.meta.url), "utf8"),
);

async function loadFragment() {
  if (fromFile) {
    return JSON.parse(fs.readFileSync(fromFile, "utf8"));
  }
  const url = `https://github.com/${JETLS_REPOSITORY}/releases/download/${manifest.revision}/${ASSET_NAME}`;
  const response = await fetch(url);
  if (response.status === 404) {
    if (checkMode) {
      // Transitional: releases predating the asset cannot be checked.
      // Once the pin moves past the first release publishing the asset,
      // this path is dead and a 404 would indicate a real problem.
      console.warn(
        `Warning: the pinned JETLS release ${manifest.revision} does not ` +
          `publish ${ASSET_NAME}; skipping the sync check.`,
      );
      process.exit(0);
    }
    console.error(`Error: ${url} not found`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`Error: failed to download ${url}: ${response.status}`);
    process.exit(1);
  }
  return await response.json();
}

const fragment = await loadFragment();
const packageJsonText = fs.readFileSync(packageJsonUrl, "utf8");
const packageJson = JSON.parse(packageJsonText);
const properties = packageJson.contributes.configuration.properties;
properties["jetls-client.settings"].properties = fragment.settings;
Object.assign(
  properties["jetls-client.initializationOptions"],
  fragment.initializationOptions,
);
const updated = `${JSON.stringify(packageJson, null, 2)}\n`;

if (checkMode) {
  // Windows checkouts may translate line endings (`core.autocrlf`), which
  // git undoes on commit, so the comparison ignores them.
  if (packageJsonText.replaceAll("\r\n", "\n") !== updated) {
    console.error(
      "Error: package.json is out of date\n" +
        "Run the following command to update it:\n" +
        "  npm run sync-schemas",
    );
    process.exit(1);
  }
  console.log("package.json is up to date");
} else {
  fs.writeFileSync(packageJsonUrl, updated);
  console.log("Updated package.json");
}
