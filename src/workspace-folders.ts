import type * as vscode from "vscode";
import type {
  DocumentFilter,
  DocumentSelector,
  RegistrationParams,
  RelativePattern,
} from "vscode-languageserver-protocol";

export const GLOBAL_CLIENT_KEY = "__global__";

export const TEXT_DOCUMENT_CONTENT_SCHEMES = [
  "jetls-testrunner-logs",
  "jetls-macro-expansion",
  "jetls-type-annotation",
] as const;

export function getClientKey(folder?: vscode.WorkspaceFolder): string {
  return folder?.uri.toString() ?? GLOBAL_CLIENT_KEY;
}

export function getClientLabel(folder?: vscode.WorkspaceFolder): string {
  return folder ? folder.name : "workspace";
}

export function getClientDisplayName(folder?: vscode.WorkspaceFolder): string {
  return folder
    ? `JETLS Language Server (${folder.name})`
    : "JETLS Language Server";
}

export function workspaceFolderContains(
  parent: vscode.WorkspaceFolder,
  child: vscode.WorkspaceFolder,
): boolean {
  if (
    parent.uri.scheme !== child.uri.scheme ||
    parent.uri.authority !== child.uri.authority
  ) {
    return false;
  }
  const parentPath = parent.uri.path.replace(/\/+$/, "") || "/";
  const childPath = child.uri.path.replace(/\/+$/, "") || "/";
  if (parentPath === childPath) {
    return false;
  }
  const parentPrefix = parentPath === "/" ? "/" : `${parentPath}/`;
  return childPath.startsWith(parentPrefix);
}

/**
 * Whether `value` starts with an explicit URI scheme. `vscode.Uri.parse`
 * reads any other string (e.g. a testset name) as a `file:` path. A
 * one-letter scheme is a Windows drive letter, not a URI scheme.
 */
export function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(value);
}

/**
 * Looks up a parameter of a virtual document URI query as exposed by
 * `vscode.Uri.query`. JETLS percent-encodes each parameter value and then
 * encodes the whole query again when serializing the URI (`%` becomes
 * `%25`), so after `vscode.Uri` decodes the query once, each value is still
 * encoded and must be decoded once more.
 */
export function getQueryParameter(
  query: string,
  name: string,
): string | undefined {
  return new URLSearchParams(query).get(name) ?? undefined;
}

export function getOutermostWorkspaceFolder(
  folder: vscode.WorkspaceFolder,
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder {
  let outermost = folder;
  for (const candidate of folders) {
    if (
      workspaceFolderContains(candidate, folder) &&
      candidate.uri.path.length < outermost.uri.path.length
    ) {
      outermost = candidate;
    }
  }
  return outermost;
}

export function getEffectiveWorkspaceFolders(
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder[] {
  const effectiveFolders = new Map<string, vscode.WorkspaceFolder>();
  for (const folder of folders) {
    const outermost = getOutermostWorkspaceFolder(folder, folders);
    const key = getClientKey(outermost);
    if (!effectiveFolders.has(key)) {
      effectiveFolders.set(key, outermost);
    }
  }
  return Array.from(effectiveFolders.values());
}

function createRelativePattern(
  folder: vscode.WorkspaceFolder,
  pattern: string,
): RelativePattern {
  return {
    baseUri: {
      uri: folder.uri.toString(),
      name: folder.name,
    },
    pattern,
  };
}

function getFilterPattern(filter: DocumentFilter): string {
  const pattern = "pattern" in filter ? filter.pattern : undefined;
  if (typeof pattern === "string") {
    return pattern;
  }
  if (
    pattern &&
    typeof pattern === "object" &&
    "pattern" in pattern &&
    typeof pattern.pattern === "string"
  ) {
    return pattern.pattern;
  }
  return "**/*";
}

export function scopeDocumentSelector(
  selector: DocumentSelector,
  folder: vscode.WorkspaceFolder | undefined,
  includeUnsavedDocuments: boolean,
): DocumentSelector {
  if (!folder) {
    return selector;
  }

  const scoped: DocumentSelector = [];
  for (const filter of selector) {
    if (typeof filter === "string") {
      scoped.push({
        scheme: "file",
        language: filter,
        pattern: createRelativePattern(folder, "**/*"),
      });
    } else if ("notebook" in filter) {
      const notebook =
        typeof filter.notebook === "string"
          ? {
              notebookType: filter.notebook,
              pattern: createRelativePattern(folder, "**/*"),
            }
          : {
              ...filter.notebook,
              pattern: createRelativePattern(folder, "**/*"),
            };
      scoped.push({ ...filter, notebook });
      if (includeUnsavedDocuments) {
        const notebookType =
          typeof filter.notebook === "string"
            ? filter.notebook
            : filter.notebook.notebookType;
        scoped.push({
          ...filter,
          notebook: {
            notebookType,
            scheme: "untitled",
          },
        });
      }
    } else if (filter.scheme === "untitled") {
      if (includeUnsavedDocuments) {
        scoped.push(filter);
      }
    } else if (filter.scheme === undefined || filter.scheme === "file") {
      scoped.push({
        ...filter,
        scheme: filter.scheme ?? "file",
        pattern: createRelativePattern(folder, getFilterPattern(filter)),
      });
    } else {
      scoped.push(filter);
    }
  }
  return scoped;
}

function hasDocumentSelector(value: unknown): value is Record<
  string,
  unknown
> & {
  documentSelector?: DocumentSelector | null;
} {
  return (
    typeof value === "object" && value !== null && "documentSelector" in value
  );
}

export function scopeRegistrationParams(
  params: RegistrationParams,
  folder: vscode.WorkspaceFolder | undefined,
  includeUnsavedDocuments: boolean,
): RegistrationParams {
  return {
    ...params,
    registrations: params.registrations.map((registration) => {
      const registerOptions = registration.registerOptions;
      if (!(
        hasDocumentSelector(registerOptions) && registerOptions.documentSelector
      )) {
        return registration;
      }
      return {
        ...registration,
        registerOptions: {
          ...registerOptions,
          documentSelector: scopeDocumentSelector(
            registerOptions.documentSelector,
            folder,
            includeUnsavedDocuments,
          ),
        },
      };
    }),
  };
}

export function createDocumentSelector(
  folder: vscode.WorkspaceFolder | undefined,
  includeUnsavedDocuments: boolean,
): DocumentSelector {
  const selector: DocumentSelector = [
    folder
      ? {
          scheme: "file",
          language: "julia",
          pattern: createRelativePattern(folder, "**/*"),
        }
      : {
          scheme: "file",
          language: "julia",
        },
    folder
      ? {
          notebook: {
            notebookType: "jupyter-notebook",
            pattern: createRelativePattern(folder, "**/*"),
          },
          language: "julia",
        }
      : {
          notebook: { notebookType: "jupyter-notebook" },
          language: "julia",
        },
  ];
  if (includeUnsavedDocuments) {
    selector.push(
      {
        scheme: "untitled",
        language: "julia",
      },
      {
        notebook: {
          notebookType: "jupyter-notebook",
          scheme: "untitled",
        },
        language: "julia",
      },
    );
  }
  return selector;
}
