// Finalizes Unreleased using the current package version and server pin.
// Usage: node scripts/update-changelog.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const CLIENT_REPOSITORY = "aviatesk/jetls-vscode";
const SERVER_REPOSITORY = "aviatesk/JETLS.jl";
const CLIENT_URL = `https://github.com/${CLIENT_REPOSITORY}`;
const SERVER_URL = `https://github.com/${SERVER_REPOSITORY}`;
const CLIENT_VERSION = /^20\d{2}\.(1[0-2]|[1-9])\.(3[01]|[12]\d|[1-9])$/;
const SERVER_VERSION = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function validateVersion(value, pattern, description) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${description}: ${value}`);
  }
}

function validateClientTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new Error(`Invalid previous client tag: ${tag}`);
  }
  validateVersion(tag.slice(1), CLIENT_VERSION, "previous client tag");
}

function markdownHeadings(text) {
  const headings = [];
  let fence;
  let inComment = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    let content = line.replace(/\r$/, "");
    if (!fence) {
      let start = inComment ? 0 : content.indexOf("<!--");
      while (start !== -1) {
        const end = content.indexOf("-->", start + (inComment ? 0 : 4));
        inComment = end === -1;
        const stop = inComment ? content.length : end + 3;
        content =
          content.slice(0, start) +
          " ".repeat(stop - start) +
          content.slice(stop);
        start = inComment ? -1 : content.indexOf("<!--", stop);
      }
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = undefined;
      }
    } else if (marker) {
      fence = marker[1];
    } else {
      const heading = /^(#{2,6}) (.+)$/.exec(content);
      if (heading) {
        headings.push({
          level: heading[1].length,
          title: heading[2].trimEnd(),
          start: offset,
          end: offset + line.length,
        });
      }
    }
    offset += line.length + 1;
  }
  return headings;
}

function clientMetadata(tag, previousTag) {
  return (
    `- Commit: [\`${tag}\`](${CLIENT_URL}/commit/${tag})\n` +
    `- Diff: [\`${previousTag}...${tag}\`](${CLIENT_URL}/compare/${previousTag}...${tag})`
  );
}

function languageServerSection(previousRevision, revision, releases) {
  if (previousRevision === revision) {
    return "";
  }
  const rollback = revision < previousRevision;
  const versions = [
    ...new Set(
      releases
        .filter((release) => !release.draft && !release.prerelease)
        .map((release) => release.tag_name)
        .filter(
          (tag) =>
            SERVER_VERSION.test(tag) &&
            (rollback
              ? tag === revision
              : previousRevision < tag && tag <= revision),
        ),
    ),
  ].sort();
  if (!versions.includes(revision)) {
    throw new Error(`Missing published server release notes for ${revision}`);
  }
  // Three-dot comparisons hide removals when the target is an ancestor.
  const comparison = `${previousRevision}${rollback ? ".." : "..."}${revision}`;
  return [
    "### Language server",
    "",
    `${rollback ? "Rolled back" : "Updated"} managed JETLS from \`${previousRevision}\` to \`${revision}\`.`,
    "",
    ...versions.map(
      (tag) =>
        `- [Release notes for ${tag}](${SERVER_URL}/releases/tag/${tag})`,
    ),
    `- [Full server diff](${SERVER_URL}/compare/${comparison})`,
  ].join("\n");
}

function finalizeChangelog(
  changelog,
  { version, revision, previousTag, previousRevision, releases },
) {
  validateVersion(version, CLIENT_VERSION, "client version");
  validateClientTag(previousTag);
  validateVersion(revision, SERVER_VERSION, "server revision");
  validateVersion(previousRevision, SERVER_VERSION, "previous server revision");
  const tag = `v${version}`;
  const sections = markdownHeadings(changelog).filter(
    ({ level }) => level === 2,
  );
  if (
    sections[0]?.title !== "Unreleased" ||
    sections.filter(({ title }) => title === "Unreleased").length !== 1
  ) {
    throw new Error(
      "Expected exactly one Unreleased section before the released history",
    );
  }
  if (sections.some(({ title }) => title === tag)) {
    throw new Error(`Release ${tag} already exists in the CHANGELOG`);
  }
  if (sections[1]?.title !== previousTag) {
    throw new Error(
      `Latest CHANGELOG release does not match published client tag ${previousTag}`,
    );
  }
  const unreleased = changelog
    .slice(sections[0].end, sections[1].start)
    .replaceAll("\r\n", "\n");
  const expectedMetadata = `\n\n${clientMetadata("HEAD", previousTag)}\n`;
  if (
    !unreleased.startsWith(expectedMetadata) ||
    !/^- Pinned JETLS:[^\n]*\n\n/.test(
      unreleased.slice(expectedMetadata.length),
    )
  ) {
    throw new Error(
      `Invalid Unreleased metadata; expected ${previousTag}...HEAD and a Pinned JETLS field`,
    );
  }
  const subsections = markdownHeadings(unreleased).filter(
    ({ level }) => level === 3,
  );
  if (
    subsections.length !== 2 ||
    subsections[0].title !== "Language server" ||
    subsections[1].title !== "VS Code extension"
  ) {
    throw new Error(
      "Expected '### Language server' followed by '### VS Code extension' in Unreleased",
    );
  }
  const clientSection = unreleased.slice(subsections[1].end).trim()
    ? unreleased.slice(subsections[1].start).trim()
    : "";
  const released = [
    `${clientMetadata(tag, previousTag)}\n` +
      `- Pinned JETLS: [\`${revision}\`](${SERVER_URL}/releases/tag/${revision})`,
    languageServerSection(previousRevision, revision, releases),
    clientSection,
  ].filter(Boolean);
  return (
    changelog.slice(0, sections[0].start) +
    `## Unreleased\n\n${clientMetadata("HEAD", tag)}\n` +
    `- Pinned JETLS: <!-- Set during release preparation; do not edit by hand. -->\n\n` +
    `### Language server\n\n` +
    `<!-- Generated during release preparation; do not edit by hand. -->\n\n` +
    `### VS Code extension\n\n` +
    `## ${tag}\n\n${released.join("\n\n")}\n\n` +
    changelog.slice(sections[1].start)
  );
}

function runGh(args) {
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

function prepareReleaseChangelog(changelog, { version, revision }) {
  const { tag_name: previousTag } = runGh([
    "api",
    `repos/${CLIENT_REPOSITORY}/releases/latest`,
  ]);
  validateClientTag(previousTag);
  const manifest = runGh([
    "api",
    `repos/${CLIENT_REPOSITORY}/contents/JETLS_VERSION.json?ref=${encodeURIComponent(previousTag)}`,
  ]);
  if (manifest.encoding !== "base64" || typeof manifest.content !== "string") {
    throw new Error(`Could not read JETLS_VERSION.json at ${previousTag}`);
  }
  const { revision: previousRevision } = JSON.parse(
    Buffer.from(manifest.content, "base64").toString("utf8"),
  );
  validateVersion(previousRevision, SERVER_VERSION, "previous server revision");
  const releases =
    previousRevision === revision
      ? []
      : runGh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${SERVER_REPOSITORY}/releases?per_page=100`,
        ]).flat();
  return finalizeChangelog(changelog, {
    version,
    revision,
    previousTag,
    previousRevision,
    releases,
  });
}

const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
const { version } = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const { revision } = JSON.parse(
  fs.readFileSync(new URL("../JETLS_VERSION.json", import.meta.url), "utf8"),
);

try {
  const changelog = fs.readFileSync(changelogUrl, "utf8");
  const updated = prepareReleaseChangelog(changelog, { version, revision });
  fs.writeFileSync(changelogUrl, updated);
  console.log("Updated CHANGELOG.md");
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
