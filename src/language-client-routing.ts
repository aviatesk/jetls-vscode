import * as vscode from "vscode";
import type { ExtensionContext } from "vscode";

import type { LanguageClient } from "vscode-languageclient/node";
import {
  ExecuteCommandRequest,
  TextDocumentContentRequest,
} from "vscode-languageserver-protocol";

import {
  getQueryParameter,
  hasUriScheme,
  TEXT_DOCUMENT_CONTENT_SCHEMES,
} from "./workspace-folders";

// Commands are registered once at the extension level (per-server
// registration would conflict), so this list and `jetls.showMessage` are the
// full set the client can execute; keep them in sync with
// `SUPPORTED_COMMANDS` in src/execute-command.jl, or new server commands fail
// as unknown VS Code commands. Each of these commands takes the URI of the
// document it acts on as its first argument, which selects the server.
const SERVER_EXECUTE_COMMANDS = [
  "jetls.testrunner.run@testset",
  "jetls.testrunner.run@test",
  "jetls.testrunner.openLogs",
  "jetls.testrunner.clearResult",
  "jetls.openMacroExpansion",
  "jetls.openTypeAnnotation",
];

function isTextDocumentContentUri(uri: vscode.Uri): boolean {
  return TEXT_DOCUMENT_CONTENT_SCHEMES.includes(
    uri.scheme as (typeof TEXT_DOCUMENT_CONTENT_SCHEMES)[number],
  );
}

function tryParseUri(value: unknown): vscode.Uri | undefined {
  if (!(typeof value === "string" && hasUriScheme(value))) {
    return undefined;
  }
  try {
    return vscode.Uri.parse(value, true);
  } catch {
    return undefined;
  }
}

export class LanguageClientRouting implements vscode.Disposable {
  private readonly textDocumentContentChangeEmitters = new Map<
    string,
    vscode.EventEmitter<vscode.Uri>
  >();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    context: ExtensionContext,
    private readonly clientForSourceUri: (
      uri: vscode.Uri,
    ) => LanguageClient | undefined,
  ) {
    this.registerExecuteCommandRouters();
    this.registerTextDocumentContentRouter();
    context.subscriptions.push(this);
  }

  refreshTextDocumentContent(uri: vscode.Uri): void {
    this.textDocumentContentChangeEmitters.get(uri.scheme)?.fire(uri);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    for (const emitter of this.textDocumentContentChangeEmitters.values()) {
      emitter.dispose();
    }
    this.textDocumentContentChangeEmitters.clear();
  }

  private clientForUri(uri: vscode.Uri): LanguageClient | undefined {
    if (!isTextDocumentContentUri(uri)) {
      return this.clientForSourceUri(uri);
    }
    const source = tryParseUri(getQueryParameter(uri.query, "source"));
    return source && !isTextDocumentContentUri(source)
      ? this.clientForSourceUri(source)
      : undefined;
  }

  private showJETLSMessage(
    args: unknown[],
  ): Thenable<string | undefined> | undefined {
    const message = args[0];
    if (typeof message !== "string") {
      void vscode.window.showWarningMessage(
        "JETLS showMessage command requires a message string.",
      );
      return undefined;
    }

    switch (args[1]) {
      case 1:
        return vscode.window.showErrorMessage(message);
      case 2:
        return vscode.window.showWarningMessage(message);
      default:
        return vscode.window.showInformationMessage(message);
    }
  }

  private async executeServerCommand(
    command: string,
    args: unknown[],
  ): Promise<unknown> {
    const uri = tryParseUri(args[0]);
    const client = uri && this.clientForUri(uri);
    if (!client) {
      void vscode.window.showWarningMessage(
        `No JETLS language server is available to execute ${command}.`,
      );
      return undefined;
    }
    return client.sendRequest(ExecuteCommandRequest.type, {
      command,
      arguments: args,
    });
  }

  private registerExecuteCommandRouters(): void {
    this.disposables.push(
      vscode.commands.registerCommand(
        "jetls.showMessage",
        (...args: unknown[]) => this.showJETLSMessage(args),
      ),
    );
    for (const command of SERVER_EXECUTE_COMMANDS) {
      this.disposables.push(
        vscode.commands.registerCommand(command, (...args: unknown[]) =>
          this.executeServerCommand(command, args),
        ),
      );
    }
  }

  private registerTextDocumentContentRouter(): void {
    for (const scheme of TEXT_DOCUMENT_CONTENT_SCHEMES) {
      const onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
      this.textDocumentContentChangeEmitters.set(scheme, onDidChangeEmitter);
      this.disposables.push(
        vscode.workspace.registerTextDocumentContentProvider(scheme, {
          onDidChange: onDidChangeEmitter.event,
          provideTextDocumentContent: async (uri, token) => {
            const client = this.clientForUri(uri);
            if (!client) {
              return `No JETLS server is available for ${uri.toString()}.`;
            }
            const result = await client.sendRequest(
              TextDocumentContentRequest.type,
              { uri: uri.toString() },
              token,
            );
            return result.text;
          },
        }),
      );
    }
  }
}

function featureRegistrationMethod(
  feature: Parameters<LanguageClient["registerFeature"]>[0],
): string | undefined {
  return (feature as { registrationType?: { method?: string } })
    .registrationType?.method;
}

export function isExecuteCommandFeature(
  feature: Parameters<LanguageClient["registerFeature"]>[0],
): boolean {
  return featureRegistrationMethod(feature) === ExecuteCommandRequest.method;
}

export function isTextDocumentContentFeature(
  feature: Parameters<LanguageClient["registerFeature"]>[0],
): boolean {
  return (
    featureRegistrationMethod(feature) === TextDocumentContentRequest.method
  );
}
