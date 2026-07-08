import * as assert from "node:assert/strict";
import * as nodePath from "node:path";
import { test } from "node:test";

import type * as vscode from "vscode";
import type { RegistrationParams } from "vscode-languageserver-protocol";

import {
  createDocumentSelector,
  getEffectiveWorkspaceFolders,
  getQueryParameter,
  hasUriScheme,
  scopeRegistrationParams,
  workspaceFolderContains,
} from "../src/workspace-folders";

interface FakeUriOptions {
  scheme: string;
  authority?: string;
  path: string;
  fsPath?: string;
}

function fakeWorkspaceFolder(
  name: string,
  options: FakeUriOptions,
): vscode.WorkspaceFolder {
  const authority = options.authority ?? "";
  const uri = {
    scheme: options.scheme,
    authority,
    path: options.path,
    fsPath: options.fsPath ?? options.path,
    toString: () => `${options.scheme}://${authority}${options.path}`,
  } as unknown as vscode.Uri;
  return { uri, name, index: 0 };
}

function fileFolder(name: string, ...parts: string[]): vscode.WorkspaceFolder {
  const fsPath = nodePath.resolve(".workspace-folders-test", ...parts);
  const uriPath = `/${fsPath.replaceAll(nodePath.sep, "/").replace(/^\/+/, "")}`;
  return fakeWorkspaceFolder(name, {
    scheme: "file",
    path: uriPath,
    fsPath,
  });
}

function scopedPattern(
  folder: vscode.WorkspaceFolder,
  pattern: string,
): {
  baseUri: { uri: string; name: string };
  pattern: string;
} {
  return {
    baseUri: { uri: folder.uri.toString(), name: folder.name },
    pattern,
  };
}

function registrationParams(): RegistrationParams {
  return {
    registrations: [
      {
        id: "sync",
        method: "textDocument/didOpen",
        registerOptions: {
          documentSelector: [
            { scheme: "file", language: "julia" },
            { scheme: "untitled", language: "julia" },
            {
              scheme: "file",
              pattern: {
                baseUri: "file:///server-root",
                pattern: ".JETLSConfig.toml",
              },
            },
            { scheme: "jetls-macro-expansion" },
          ],
        },
      },
      {
        id: "configuration",
        method: "workspace/didChangeConfiguration",
        registerOptions: { section: "jetls-client.settings" },
      },
    ],
  };
}

test("keeps unrelated workspace roots separate", () => {
  const first = fileFolder("first", "first");
  const second = fileFolder("second", "second");

  assert.deepEqual(getEffectiveWorkspaceFolders([first, second]), [
    first,
    second,
  ]);
});

test("collapses nested workspace roots to the outermost root", () => {
  const outer = fileFolder("outer", "project");
  const nested = fileFolder("nested", "project", "packages", "nested");
  const deepest = fileFolder("deepest", "project", "packages", "nested", "src");

  assert.deepEqual(getEffectiveWorkspaceFolders([deepest, nested, outer]), [
    outer,
  ]);
});

test("checks containment at path, scheme, and authority boundaries", () => {
  const parent = fileFolder("parent", "project");
  const child = fileFolder("child", "project", "src");
  const sibling = fileFolder("sibling", "project-extra");

  assert.equal(workspaceFolderContains(parent, child), true);
  assert.equal(workspaceFolderContains(parent, sibling), false);
  assert.equal(workspaceFolderContains(parent, parent), false);

  const remoteParent = fakeWorkspaceFolder("remote", {
    scheme: "vscode-remote",
    authority: "ssh-remote+host-a",
    path: "/workspace/project",
  });
  const remoteChild = fakeWorkspaceFolder("remote child", {
    scheme: "vscode-remote",
    authority: "ssh-remote+host-a",
    path: "/workspace/project/src",
  });
  const boundarySibling = fakeWorkspaceFolder("remote sibling", {
    scheme: "vscode-remote",
    authority: "ssh-remote+host-a",
    path: "/workspace/project-extra",
  });
  const otherAuthority = fakeWorkspaceFolder("other authority", {
    scheme: "vscode-remote",
    authority: "ssh-remote+host-b",
    path: "/workspace/project/src",
  });
  const otherScheme = fakeWorkspaceFolder("other scheme", {
    scheme: "untitled",
    authority: "ssh-remote+host-a",
    path: "/workspace/project/src",
  });

  assert.equal(workspaceFolderContains(remoteParent, remoteChild), true);
  assert.equal(workspaceFolderContains(remoteParent, boundarySibling), false);
  assert.equal(workspaceFolderContains(remoteParent, otherAuthority), false);
  assert.equal(workspaceFolderContains(remoteParent, otherScheme), false);
});

test("scopes document selectors and assigns untitled documents to the owner", () => {
  const owner = fileFolder("owner", "owner");
  const secondary = fileFolder("secondary", "secondary");

  assert.deepEqual(createDocumentSelector(owner, true), [
    {
      scheme: "file",
      language: "julia",
      pattern: scopedPattern(owner, "**/*"),
    },
    {
      notebook: {
        notebookType: "jupyter-notebook",
        pattern: scopedPattern(owner, "**/*"),
      },
      language: "julia",
    },
    { scheme: "untitled", language: "julia" },
    {
      notebook: {
        notebookType: "jupyter-notebook",
        scheme: "untitled",
      },
      language: "julia",
    },
  ]);
  assert.deepEqual(createDocumentSelector(secondary, false), [
    {
      scheme: "file",
      language: "julia",
      pattern: scopedPattern(secondary, "**/*"),
    },
    {
      notebook: {
        notebookType: "jupyter-notebook",
        pattern: scopedPattern(secondary, "**/*"),
      },
      language: "julia",
    },
  ]);
});

test("creates unscoped selectors for a rootless client", () => {
  assert.deepEqual(createDocumentSelector(undefined, true), [
    { scheme: "file", language: "julia" },
    {
      notebook: { notebookType: "jupyter-notebook" },
      language: "julia",
    },
    { scheme: "untitled", language: "julia" },
    {
      notebook: {
        notebookType: "jupyter-notebook",
        scheme: "untitled",
      },
      language: "julia",
    },
  ]);
});

test("scopes registration selectors to the folder", () => {
  const folder = fileFolder("project", "project");
  const params = registrationParams();

  assert.deepEqual(scopeRegistrationParams(params, folder, false), {
    registrations: [
      {
        id: "sync",
        method: "textDocument/didOpen",
        registerOptions: {
          documentSelector: [
            {
              scheme: "file",
              language: "julia",
              pattern: scopedPattern(folder, "**/*"),
            },
            {
              scheme: "file",
              pattern: scopedPattern(folder, ".JETLSConfig.toml"),
            },
            { scheme: "jetls-macro-expansion" },
          ],
        },
      },
      ...params.registrations.slice(1),
    ],
  });
});

test("keeps rootless registration selectors global", () => {
  assert.deepEqual(
    scopeRegistrationParams(registrationParams(), undefined, true),
    registrationParams(),
  );
});

// Mirrors how JETLS serializes a virtual document URI: each query value is
// percent-encoded, then the whole query is encoded again, and `vscode.Uri`
// decodes the query once when parsing the URI.
function serverQueryAsSeenByVSCode(parameters: [string, string][]): string {
  const escape = (value: string): string =>
    Array.from(new TextEncoder().encode(value), (byte) =>
      /[A-Za-z0-9\-._]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    ).join("");
  const query = parameters
    .map(([key, value]) => `${escape(key)}=${escape(value)}`)
    .join("&");
  const serialized = query.replaceAll("%", "%25");
  return decodeURIComponent(serialized);
}

test("reads query parameters of server-generated virtual document URIs", () => {
  const source = "file:///work/C++/R&D/a b+c=d.jl";
  const query = serverQueryAsSeenByVSCode([
    ["source", source],
    ["start", "1"],
    ["stop", "10"],
  ]);

  assert.equal(getQueryParameter(query, "source"), source);
  assert.equal(getQueryParameter(query, "stop"), "10");
  assert.equal(getQueryParameter(query, "index"), undefined);
  assert.equal(getQueryParameter("", "source"), undefined);
});

test("recognizes only strings with an explicit URI scheme", () => {
  assert.equal(hasUriScheme("file:///work/test.jl"), true);
  assert.equal(hasUriScheme("vscode-notebook-cell:/a.ipynb#X1"), true);
  assert.equal(hasUriScheme("jetls-testrunner-logs:/testrunner/logs"), true);
  assert.equal(hasUriScheme("my testset"), false);
  assert.equal(hasUriScheme("/work/test.jl"), false);
  assert.equal(hasUriScheme("C:\\work\\test.jl"), false);
  assert.equal(hasUriScheme(""), false);
});
