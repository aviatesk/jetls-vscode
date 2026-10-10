"use strict";

import * as vscode from "vscode";
import { ExtensionContext, LogOutputChannel } from "vscode";

import {
  activateServerLifecycle,
  reconcileFolderServers,
  requestLanguageServerRestart,
  reinstallServer,
  restartOnServerConfigChange,
  showOutputChannel,
  shutdownServerLifecycle,
} from "./server-lifecycle";
import { StartupStatusBar } from "./status-bar";

let outputChannel: LogOutputChannel;
let statusBar: StartupStatusBar;

export function activate(context: ExtensionContext) {
  statusBar = new StartupStatusBar();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) =>
      restartOnServerConfigChange(event),
    ),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      outputChannel.appendLine(
        "[jetls-client] Workspace folders changed. Updating language servers...",
      );
      reconcileFolderServers();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("jetls-client.restartLanguageServer", () =>
      requestLanguageServerRestart(),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("jetls-client.reinstallServer", () => {
      void reinstallServer().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(
          `[jetls-client] Failed to reinstall the managed JETLS: ${message}.`,
        );
      });
    }),
  );

  outputChannel = vscode.window.createOutputChannel("JETLS", { log: true });
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "jetls-client.showOutput",
      (serverId?: unknown) =>
        showOutputChannel(typeof serverId === "string" ? serverId : undefined),
    ),
  );

  activateServerLifecycle(outputChannel, statusBar, context);

  reconcileFolderServers();
}

export async function deactivate() {
  statusBar?.suppress();
  await shutdownServerLifecycle();
  if (outputChannel) {
    outputChannel.dispose();
  }
  if (statusBar) {
    statusBar.dispose();
  }
}
