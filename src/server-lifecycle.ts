import * as vscode from "vscode";
import { LogOutputChannel } from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  TransportKind,
} from "vscode-languageclient/node";
import { TextDocumentContentRefreshRequest } from "vscode-languageserver-protocol";

import { CoalescingTaskRunner } from "./coalescing-task-runner";
import { stopClient } from "./client-shutdown";
import {
  JETLS_CLIENT_SETTINGS_SECTION,
  MINIMUM_CUSTOM_JETLS_REVISION,
  TIMEOUTS,
} from "./constants";
import {
  isExecuteCommandFeature,
  isTextDocumentContentFeature,
  LanguageClientRouting,
} from "./language-client-routing";
import {
  ensureManagedJETLS,
  invalidateInstallStamp,
  LAST_USED_REFRESH_INTERVAL,
  ManagedInstallationCancelledError,
  ManagedJETLSError,
  ManagedJETLSInstallation,
  managedJETLSCommands,
  resolveManagedStoragePath,
  touchManagedInstallation,
} from "./managed-installation";
import {
  affectsServerConfig,
  getServerConfig,
  hasServerConfigChanged,
  isManagedExecutable,
  ServerConfig,
} from "./server-config";
import {
  JETLSCommands,
  resolveJETLSCommands,
  UnsupportedJETLSVersionError,
  VersionPreflight,
} from "./preflight";
import { ServerStartupStatus, StartupStatusBar } from "./status-bar";
import { connectSocketTransport, TransportOptions } from "./transport";
import {
  createDocumentSelector,
  getClientDisplayName,
  getClientKey,
  getEffectiveWorkspaceFolders,
  getOutermostWorkspaceFolder,
  scopeRegistrationParams,
} from "./workspace-folders";

let outputChannel: LogOutputChannel;
let statusBar: StartupStatusBar;
let deactivating = false;
let globalStoragePath: string;
let routing: LanguageClientRouting;
let nextServerId = 0;

const folderServers = new Map<string, FolderServer>();
// Teardowns of removed folders' servers: a re-added folder's new server
// starts only after them, so the two servers never run side by side.
const retiringTeardowns = new Map<string, Promise<void>>();
// Kept until deactivation: a stopped server's process may still print
// after its folder was removed, and writing to a disposed channel throws.
const folderOutputChannels = new Map<string, LogOutputChannel>();

export function activateServerLifecycle(
  channel: LogOutputChannel,
  bar: StartupStatusBar,
  context: vscode.ExtensionContext,
): void {
  outputChannel = channel;
  statusBar = bar;
  globalStoragePath = context.globalStorageUri.fsPath;
  deactivating = false;
  routing = new LanguageClientRouting(context, (uri) => {
    const client = folderServerForUri(uri)?.client;
    return client?.isRunning() ? client : undefined;
  });
}

function executableEnvironment(executable: {
  env?: Record<string, string>;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...executable.env,
  };
}

function getFolderServerConfig(
  folder: vscode.WorkspaceFolder | undefined,
): ServerConfig {
  return getServerConfig(
    vscode.workspace.getConfiguration("jetls-client", folder?.uri),
  );
}

function getFolderOutputChannel(
  folder: vscode.WorkspaceFolder | undefined,
): LogOutputChannel {
  const key = getClientKey(folder);
  let channel = folderOutputChannels.get(key);
  if (channel === undefined) {
    channel = vscode.window.createOutputChannel(getClientDisplayName(folder), {
      log: true,
    });
    folderOutputChannels.set(key, channel);
  }
  return channel;
}

/**
 * The language server of one top-level workspace folder, or of the whole
 * window when no folder is open. Each server has its own restart runner,
 * so a slow start of one folder's server never delays another's.
 */
class FolderServer {
  readonly key: string;
  /** Unique per server, unlike `key`, which a re-added folder reuses. */
  readonly id = `jetls-client-${nextServerId++}`;
  readonly outputChannel: LogOutputChannel;
  readonly preflight: VersionPreflight;
  readonly restartRunner = new CoalescingTaskRunner(() =>
    restartLanguageServer(this),
  );
  client: LanguageClient | undefined;
  serverConfig: ServerConfig | null = null;
  /**
   * Whether the client handles every file rather than only those in its
   * folder, which is the case while at most one workspace folder is open.
   */
  unscoped = false;
  retired = false;
  cancelServerStartup: (() => void) | undefined;
  // Aborts this server's wait for the managed setup, so a restart or
  // removal does not wait behind a long installation.
  managedSetupAbort: AbortController | undefined;
  // Re-touches the running managed server's last-used markers: cleanup in
  // other windows judges liveness by them, and they otherwise only record
  // starts, which a long-lived session outlives.
  managedLastUsedRefresh: NodeJS.Timeout | undefined;

  constructor(public folder: vscode.WorkspaceFolder | undefined) {
    this.key = getClientKey(folder);
    this.outputChannel = getFolderOutputChannel(folder);
    this.preflight = new VersionPreflight({
      timeoutMs: TIMEOUTS.precompilation,
      terminationTimeoutMs: TIMEOUTS.processTermination,
      platform: process.platform,
      minimumRevision: MINIMUM_CUSTOM_JETLS_REVISION,
      appendLine: (message) => this.outputChannel.appendLine(message),
      onPrecompiling: () => this.showStatus("precompiling"),
    });
  }

  /** Whether the running start is no longer wanted. */
  get superseded(): boolean {
    return deactivating || this.retired || this.restartRunner.pending;
  }

  showStatus(status: ServerStartupStatus): void {
    if (!this.retired) {
      statusBar.show(this.id, status);
    }
  }
}

/**
 * The key of the server handling unsaved documents: that of the first
 * workspace folder. VS Code restarts extensions when the first folder
 * changes, so the owner never changes while its server runs.
 */
function untitledOwnerKey(): string {
  return getClientKey(
    getEffectiveWorkspaceFolders(vscode.workspace.workspaceFolders ?? [])[0],
  );
}

function folderServerForUri(uri: vscode.Uri): FolderServer | undefined {
  if (folderServers.size === 1) {
    return folderServers.values().next().value;
  }
  const uriString = uri.toString();
  const sourceUri =
    vscode.workspace.notebookDocuments.find((notebook) =>
      notebook
        .getCells()
        .some((cell) => cell.document.uri.toString() === uriString),
    )?.uri ?? uri;
  const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
  if (folder) {
    return folderServers.get(
      getClientKey(
        getOutermostWorkspaceFolder(
          folder,
          vscode.workspace.workspaceFolders ?? [],
        ),
      ),
    );
  }
  return sourceUri.scheme === "untitled"
    ? folderServers.get(untitledOwnerKey())
    : undefined;
}

type LanguageClientFeature = Parameters<LanguageClient["registerFeature"]>[0];

// Every server would register the same VS Code commands and virtual
// document providers, which VS Code rejects, so `LanguageClientRouting`
// registers them once instead.
class JETLSLanguageClient extends LanguageClient {
  override registerFeature(feature: LanguageClientFeature): void {
    if (
      isExecuteCommandFeature(feature) ||
      isTextDocumentContentFeature(feature)
    ) {
      const routedFeature = feature as LanguageClientFeature & {
        register(data: unknown): void;
        initialize?(capabilities: unknown, documentSelector: unknown): void;
      };
      routedFeature.register = () => undefined;
      if (isTextDocumentContentFeature(feature)) {
        // Its `initialize` runs on every (re)start and would replace the
        // refresh request handler that routes to `LanguageClientRouting`.
        routedFeature.initialize = () => undefined;
      }
    }
    super.registerFeature(feature);
  }
}

// The one-line notification and tooltip text; the full failure details
// stay in the output channel. Setup failures always arrive as
// `ManagedJETLSError`, so the fallback prefix only describes failures of
// the spawned server itself.
function managedFailureSummary(err: Error): string {
  if (err instanceof ManagedJETLSError) {
    return err.summary;
  }
  const newline = err.message.indexOf("\n");
  const line = newline === -1 ? err.message : err.message.slice(0, newline);
  return `Failed to start the managed JETLS server: ${line}`;
}

function showManagedFailureNotification(err: Error, serverId?: string): void {
  const details = err instanceof ManagedJETLSError ? err : undefined;
  const retryButton = "Retry";
  const outputButton = "Show JETLS output";
  const settingsButton = "Open settings";
  const buttons: string[] = [];
  // A configuration problem needs a settings change before a retry can
  // help.
  if (details === undefined || details.retryable) {
    buttons.push(retryButton);
  }
  buttons.push(outputButton);
  if (details !== undefined && !details.retryable) {
    buttons.push(settingsButton);
  }
  vscode.window
    .showErrorMessage(managedFailureSummary(err), ...buttons)
    .then((selection) => {
      if (selection === retryButton) {
        requestLanguageServerRestart();
      } else if (selection === outputButton) {
        showOutputChannel(serverId);
      } else if (selection === settingsButton) {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          details?.setting ?? "jetls-client.executable",
        );
      }
    });
}

// Managed failures take two distinct paths. A setup failure happens before
// `ensureManagedJETLS` produced a verified installation: nothing new is
// known about any generation's verified state, so no install stamp is
// touched. A server failure comes from a process launched out of a
// verified generation and is the one corruption signal the install stamp
// cannot see, so the stamp of the generation this lifecycle actually used
// is dropped: the next start then re-verifies that generation and
// replaces it with a fresh one if broken.
function handleManagedSetupFailure(err: Error): void {
  outputChannel.appendLine(
    `[jetls-client] Failed to set up the managed JETLS: ${err.message}`,
  );
  showManagedFailureNotification(err);
}

function handleManagedServerFailure(
  server: FolderServer,
  err: Error,
  depotPath: string,
): void {
  server.outputChannel.appendLine(
    `[jetls-client] Failed to start the managed JETLS: ${err.message}`,
  );
  void invalidateInstallStamp(depotPath).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    server.outputChannel.appendLine(
      `[jetls-client] Failed to invalidate the managed install stamp: ${message}.`,
    );
  });
  showManagedFailureNotification(err, server.id);
}

// Handles a custom executable that predates the launch arguments this
// client uses: without the preflight gate the server would reject the
// arguments and the start would only fail as an opaque timeout.
function handleUnsupportedExecutable(
  server: FolderServer,
  err: UnsupportedJETLSVersionError,
): void {
  server.outputChannel.appendLine(
    `[jetls-client] Failed to start JETLS: ${err.message}`,
  );
  const settingsButton = "Open settings";
  void vscode.window
    .showErrorMessage(err.message, settingsButton)
    .then((selection) => {
      if (selection === settingsButton) {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "jetls-client.executable",
        );
      }
    });
}

// Handles spawn errors of custom executable configurations.
function handleSpawnError(
  server: FolderServer,
  err: Error,
  command: string,
): void {
  const errno = err as NodeJS.ErrnoException;
  if (errno.code === "ENOENT") {
    server.outputChannel.appendLine(
      `[jetls-client] Failed to start JETLS: Command not found: ${command}`,
    );
    server.outputChannel.appendLine(`[jetls-client] PATH: ${process.env.PATH}`);
    void vscode.window.showErrorMessage(
      `JETLS executable not found: "${command}". Check the ` +
        "`jetls-client.executable` setting, or remove its `path`/command to " +
        "use the managed installation. If the command was just installed, " +
        "restart VS Code to refresh the PATH.",
    );
  } else {
    server.outputChannel.appendLine(
      `[jetls-client] Failed to start JETLS: ${err.message}`,
    );
  }
}

// The stdio and pipe channels have no process-level startup monitoring
// (the language client library owns the spawned process), so bound
// `start()` itself and force-dispose the client on expiry.
function startWithTimeout(
  client: LanguageClient,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      void client.dispose().catch(() => undefined);
      reject(new Error("Timeout waiting for JETLS to start"));
    }, timeoutMs);
    client.start().then(
      () => {
        clearTimeout(timeoutHandle);
        resolve();
      },
      (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      },
    );
  });
}

/**
 * A managed JETLS setup shared by the servers that need the same
 * installation, so that concurrently starting servers install once and a
 * failed or cancelled installation is reported once instead of retried by
 * each server in turn. It belongs to the extension rather than to any
 * server: only its notification's Cancel and deactivation abort it.
 */
class ManagedSetup {
  readonly installation: Promise<ManagedJETLSInstallation>;
  private readonly abortController = new AbortController();
  private installProgress: vscode.Progress<{ message?: string }> | undefined;
  private installPhase: string | undefined;

  constructor(
    configuredStoragePath: string,
    environment: NodeJS.ProcessEnv,
    forceInstall: boolean,
  ) {
    // Resolving the storage path inside the async function turns an
    // invalid setting into a setup failure.
    this.installation = (async () =>
      ensureManagedJETLS({
        storagePath: resolveManagedStoragePath(
          globalStoragePath,
          configuredStoragePath,
        ),
        environment,
        logger: (message) =>
          outputChannel.appendLine(`[jetls-client] ${message}`),
        progress: (message) => {
          statusBar.showManagedProgress(message);
          this.installPhase = message.startsWith("Installing JETLS: ")
            ? message.slice("Installing JETLS: ".length).replace(/\.\.\.$/, "")
            : undefined;
          this.installProgress?.report({
            message: this.installPhase ?? message,
          });
        },
        forceInstall,
        signal: this.abortController.signal,
        onInstallOutput: (line) => {
          statusBar.showManagedProgressDetail(line);
          this.installProgress?.report({
            message:
              this.installPhase === undefined
                ? line
                : `${this.installPhase} — ${line}`,
          });
        },
        onInstallStep: () => this.beginInstallStep(),
      }))();
    void this.installation.then(
      () => statusBar.clearManagedProgress(),
      (err) => {
        statusBar.clearManagedProgress();
        this.reportFailure(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  abort(): void {
    this.abortController.abort();
  }

  /** Waits for the installation; aborting `signal` only ends this wait. */
  wait(signal: AbortSignal): Promise<ManagedJETLSInstallation> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void =>
        reject(new ManagedInstallationCancelledError());
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void this.installation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  // The actual installation (the only open-ended long step) gets a
  // cancellable progress notification for its duration; routine
  // starts stay on the status bar alone.
  private beginInstallStep(): () => void {
    let ended = false;
    let end!: () => void;
    const done = new Promise<void>((resolve) => {
      end = resolve;
    });
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Installing JETLS",
        cancellable: true,
      },
      (progress, token) => {
        // VS Code runs this task asynchronously, so a step that
        // failed immediately may have ended before it: publishing
        // the progress then would leave a stale reference behind
        // the cleanup below.
        if (!ended) {
          this.installProgress = progress;
          const cancellation = token.onCancellationRequested(() =>
            this.abort(),
          );
          void done.then(() => cancellation.dispose());
        }
        return done;
      },
    );
    return () => {
      ended = true;
      this.installProgress = undefined;
      end();
    };
  }

  private reportFailure(err: Error): void {
    if (deactivating) {
      return;
    }
    if (!(err instanceof ManagedInstallationCancelledError)) {
      handleManagedSetupFailure(err);
      return;
    }
    // Cancelled from the installation notification (deactivation would
    // have set the flag above): the notification offers the way back in.
    const retryButton = "Retry";
    const outputButton = "Show JETLS output";
    void vscode.window
      .showInformationMessage(
        "The JETLS installation was cancelled.",
        retryButton,
        outputButton,
      )
      .then((choice) => {
        if (choice === retryButton) {
          requestLanguageServerRestart();
        } else if (choice === outputButton) {
          showOutputChannel();
        }
      });
  }
}

const managedSetups = new Map<string, ManagedSetup>();

async function setUpManagedJETLS(
  server: FolderServer,
  serverConfig: ServerConfig,
  executable: { env?: Record<string, string> },
): Promise<ManagedJETLSInstallation> {
  const forceInstall = forceManagedInstall;
  const setupKey = JSON.stringify({
    storagePath: serverConfig.managedStoragePath,
    env: executable.env ?? {},
    forceInstall,
  });
  let setup = managedSetups.get(setupKey);
  if (setup === undefined) {
    setup = new ManagedSetup(
      serverConfig.managedStoragePath,
      executableEnvironment(executable),
      forceInstall,
    );
    managedSetups.set(setupKey, setup);
    void setup.installation
      .catch(() => undefined)
      .finally(() => managedSetups.delete(setupKey));
  }
  const setupAbort = new AbortController();
  server.managedSetupAbort = setupAbort;
  try {
    const installation = await setup.wait(setupAbort.signal);
    if (forceInstall) {
      forceManagedInstall = false;
    }
    return installation;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // The setup itself notifies its failure once; each waiting server only
    // reflects it.
    if (!server.superseded) {
      if (error instanceof ManagedInstallationCancelledError) {
        statusBar.showManagedCancelled(server.id);
      } else {
        statusBar.showManagedFailure(server.id, managedFailureSummary(error));
        server.outputChannel.appendLine(
          `[jetls-client] Failed to set up the managed JETLS: ${error.message}`,
        );
      }
    }
    throw error;
  } finally {
    if (server.managedSetupAbort === setupAbort) {
      server.managedSetupAbort = undefined;
    }
  }
}

async function startLanguageServer(server: FolderServer) {
  if (server.superseded) {
    return;
  }
  server.showStatus("checking");

  const folder = server.folder;
  const serverConfig = getFolderServerConfig(folder);
  server.serverConfig = serverConfig;
  const managed = isManagedExecutable(serverConfig.executable);

  let resolvedCommands: JETLSCommands;
  let spawnEnv: NodeJS.ProcessEnv;
  let managedDepotPath: string | undefined;
  if (managed) {
    const executable = serverConfig.executable as {
      threads?: string;
      env?: Record<string, string>;
    };
    const installation = await setUpManagedJETLS(
      server,
      serverConfig,
      executable,
    );
    server.outputChannel.appendLine(
      `[jetls-client] Using managed JETLS from ${installation.depotPath}`,
    );
    managedDepotPath = installation.depotPath;
    resolvedCommands = managedJETLSCommands(installation, executable.threads);
    spawnEnv = installation.env;
  } else {
    try {
      resolvedCommands = resolveJETLSCommands(serverConfig.executable);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!server.superseded) {
        server.showStatus("failed");
        server.outputChannel.appendLine(`[jetls-client] ${error.message}`);
        vscode.window.showErrorMessage(error.message);
      }
      throw error;
    }
    spawnEnv = Array.isArray(serverConfig.executable)
      ? { ...process.env }
      : executableEnvironment(serverConfig.executable);
  }
  const { command: baseCommand, versionArgs, serveArgs } = resolvedCommands;

  let commChannel = serverConfig.communicationChannel;
  if (commChannel === "auto") {
    commChannel = "pipe";
    if (vscode.env.remoteName) {
      server.outputChannel.appendLine(
        `[jetls-client] Detected remote environment: ${vscode.env.remoteName}`,
      );

      // For containers, stdio might be safer than pipe
      if (
        vscode.env.remoteName === "dev-container" ||
        vscode.env.remoteName === "attached-container"
      ) {
        commChannel = "stdio";
        server.outputChannel.appendLine(
          `[jetls-client] Using stdio for container environment`,
        );
      }
    }
    server.outputChannel.appendLine(
      `[jetls-client] Auto-selected communication channel: ${commChannel}`,
    );
  }

  server.outputChannel.appendLine(
    `[jetls-client] Using communication channel: ${commChannel}`,
  );

  // On Windows, custom commands may resolve to batch files (e.g. the
  // `Pkg.Apps` launcher shim), which must be spawned with shell: true. The
  // managed server spawns the Julia executable directly and never needs
  // the shell.
  const useShell = !managed && process.platform === "win32";
  const spawnOptions: { env: NodeJS.ProcessEnv; shell?: boolean } = {
    env: spawnEnv,
    ...(useShell ? { shell: true } : {}),
  };

  // `ensureManagedJETLS` already validates the managed installation
  // (existence on every start, pinned version via verification or the
  // install stamp), so the version preflight would only repeat a full JETLS
  // load. Run it for custom executables only, where nothing else has
  // checked the command.
  if (!managed) {
    try {
      await server.preflight.run(baseCommand, versionArgs, spawnOptions);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // If a restart request is queued, this failure is most likely the
      // deliberate kill from `requestServerRestart`; skip the error surface
      // here and let the rerun repaint the status from "checking".
      if (!server.superseded) {
        server.showStatus("failed");
        if (error instanceof UnsupportedJETLSVersionError) {
          handleUnsupportedExecutable(server, error);
        } else {
          handleSpawnError(server, error, baseCommand);
        }
      }
      throw error;
    }
  }

  if (server.superseded) {
    return;
  }
  server.showStatus("starting");

  let serverOptions: ServerOptions;

  const transportOptions: TransportOptions = {
    startTimeoutMs: TIMEOUTS.serverStart,
    precompilationTimeoutMs: TIMEOUTS.precompilation,
    appendLine: (message) => server.outputChannel.appendLine(message),
    onPrecompiling: () => server.showStatus("precompiling"),
    onProcessError: (error) => {
      if (
        deactivating ||
        server.retired ||
        server.restartRunner.active !== undefined
      ) {
        return;
      }
      if (managedDepotPath === undefined) {
        handleSpawnError(server, error, baseCommand);
      } else {
        handleManagedServerFailure(server, error, managedDepotPath);
      }
    },
    registerCancel: (cancel) => {
      server.cancelServerStartup = cancel;
    },
  };

  if (commChannel === "stdio") {
    serverOptions = {
      run: {
        command: baseCommand,
        args: [...serveArgs, "--stdio"],
        options: spawnOptions,
      },
      debug: {
        command: baseCommand,
        args: [...serveArgs, "--stdio"],
        options: spawnOptions,
      },
    };
  } else if (commChannel === "socket") {
    const port = serverConfig.socketPort || 0;
    serverOptions = () =>
      connectSocketTransport(
        baseCommand,
        serveArgs,
        spawnOptions,
        port,
        transportOptions,
      );
    server.outputChannel.appendLine(`[jetls-client] Using TCP socket mode`);
  } else {
    // Default: pipe communication (Unix domain socket / named pipe).
    // The library generates the pipe name, appends `--pipe=<name>` (which the
    // server accepts as an alias for `--pipe-connect`), and owns the spawned
    // process, forwarding its stderr to the output channel.
    serverOptions = {
      run: {
        command: baseCommand,
        args: [...serveArgs],
        transport: TransportKind.pipe,
        options: spawnOptions,
      },
      debug: {
        command: baseCommand,
        args: [...serveArgs],
        transport: TransportKind.pipe,
        options: spawnOptions,
      },
    };
  }

  const initializationOptions = {
    ...serverConfig.initializationOptions,
    // Declare the section this extension stores server settings under; the
    // server registers `workspace/didChangeConfiguration` with it so the
    // configuration sync feature only sends the notification when that
    // section actually changes. This requires a server that understands the
    // `configuration_section` initialization option, which the managed
    // installation guarantees.
    configuration_section: JETLS_CLIENT_SETTINGS_SECTION,
    // Pull the live diagnostics of open files: the client clears them as soon
    // as a tab closes, which the server cannot tell from `textDocument/didClose`.
    // This also requires a server that understands the option.
    pull_diagnostics: true,
  };

  // Decided when the client is created, so that workspace folder changes
  // during a long setup are respected; later changes restart the server
  // (see `reconcileFolderServers`).
  const unscoped =
    getEffectiveWorkspaceFolders(vscode.workspace.workspaceFolders ?? [])
      .length <= 1;
  const selectorFolder = unscoped ? undefined : folder;
  const includeUnsavedDocuments = server.key === untitledOwnerKey();

  const clientOptions: LanguageClientOptions = {
    workspaceFolder: folder,
    // Keep this selector as a static-registration fallback while jetls-client can
    // connect to independently installed JETLS versions. Once the extension manages
    // the `jetls` binary, rely only on server-side dynamic registration and remove it.
    documentSelector: createDocumentSelector(
      selectorFolder,
      includeUnsavedDocuments,
    ),
    // Every client shares the `jetls-client` id (which also names the
    // `jetls-client.trace.server` setting), so keep collections apart.
    diagnosticCollectionName: server.id,
    middleware: {
      handleRegisterCapability: async (params, next) => {
        const tokenSource = new vscode.CancellationTokenSource();
        try {
          await next(
            scopeRegistrationParams(
              params,
              selectorFolder,
              includeUnsavedDocuments,
            ),
            tokenSource.token,
          );
        } finally {
          tokenSource.dispose();
        }
      },
      workspace: {
        // Unlike a handler registered with `onRequest`, this survives the
        // automatic restarts of vscode-languageclient, which reinstall its
        // default handler. JETLS requests the configuration without a
        // scope, so answer with the folder's settings.
        configuration: (params) =>
          params.items.map((item) =>
            vscode.workspace.getConfiguration(
              JETLS_CLIENT_SETTINGS_SECTION,
              item.scopeUri ? vscode.Uri.parse(item.scopeUri) : folder?.uri,
            ),
          ),
        // The server registers `workspace/didChangeConfiguration` with the
        // section declared via `configuration_section` above, so the
        // configuration sync feature only fires when `jetls-client.settings`
        // changes. Still skip the send when the same change has queued a
        // restart or shutdown is underway: it would race the client teardown,
        // and the replacement server pulls fresh configuration on initialize
        // anyway.
        didChangeConfiguration: (sections, next) => {
          if (server.superseded) {
            return Promise.resolve();
          }
          return next(sections);
        },
      },
      // `editor.action.showReferences` is a built-in VSCode command that
      // requires actual `vscode.Uri`/`vscode.Position`/`vscode.Location`
      // instances, but server-sent command arguments arrive as plain JSON.
      // Convert them here before VSCode dispatches the command.
      resolveCodeLens: async (codeLens, token, next) => {
        const resolved = await next(codeLens, token);
        if (
          resolved?.command?.command === "editor.action.showReferences" &&
          Array.isArray(resolved.command.arguments) &&
          resolved.command.arguments.length === 3
        ) {
          const [uriString, pos, locs] = resolved.command.arguments as [
            string,
            { line: number; character: number },
            {
              uri: string;
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
            }[],
          ];
          resolved.command.arguments = [
            vscode.Uri.parse(uriString),
            new vscode.Position(pos.line, pos.character),
            locs.map(
              (loc) =>
                new vscode.Location(
                  vscode.Uri.parse(loc.uri),
                  new vscode.Range(
                    loc.range.start.line,
                    loc.range.start.character,
                    loc.range.end.line,
                    loc.range.end.character,
                  ),
                ),
            ),
          ];
        }
        return resolved;
      },
    },
    initializationOptions,
    outputChannel: server.outputChannel,
  };

  const languageClient = new JETLSLanguageClient(
    "jetls-client",
    getClientDisplayName(folder),
    serverOptions,
    clientOptions,
  );
  server.client = languageClient;
  server.unscoped = unscoped;

  // Surface server crashes and vscode-languageclient's automatic restarts in
  // the status bar. This fires for every state transition, but while the
  // extension runs its own start/restart/shutdown flow (runner active, or
  // deactivating) the startup code sets the status directly, so those
  // transitions are skipped: what remains are the transitions
  // vscode-languageclient initiated on its own, i.e. a crash-triggered stop
  // and the restart its error handler performs afterwards.
  languageClient.onDidChangeState((event) => {
    if (
      deactivating ||
      server.retired ||
      server.restartRunner.active !== undefined
    ) {
      return;
    }
    switch (event.newState) {
      case State.Stopped:
        server.showStatus("crashed");
        break;
      case State.Starting:
        server.showStatus("restarting");
        break;
      case State.Running:
        server.showStatus("ready");
        break;
    }
  });

  try {
    // The socket transport bounds (and cancels) its own connection
    // attempt; the library-owned stdio and pipe starts are bounded here.
    if (commChannel === "socket") {
      await languageClient.start();
    } else {
      await startWithTimeout(languageClient, TIMEOUTS.serverStart);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // If a restart request is queued, this failure is most likely the
    // deliberate cancellation from `requestServerRestart`; skip the error
    // surface here and let the rerun repaint the status from "checking".
    if (!server.superseded) {
      if (managedDepotPath !== undefined) {
        statusBar.showManagedFailure(server.id, managedFailureSummary(error));
        handleManagedServerFailure(server, error, managedDepotPath);
      } else {
        server.showStatus("failed");
        handleSpawnError(server, error, baseCommand);
      }
    }
    throw error;
  } finally {
    server.cancelServerStartup = undefined;
  }

  if (deactivating || server.retired) {
    return;
  }
  const serverInfo = languageClient.initializeResult?.serverInfo;
  if (serverInfo) {
    server.outputChannel.appendLine(
      `[jetls-client] JETLS is ready! (${serverInfo.name} [version: ${serverInfo.version ?? "unknown"}])`,
    );
  } else {
    server.outputChannel.appendLine("[jetls-client] JETLS is ready!");
  }

  if (managedDepotPath !== undefined) {
    const depotPath = managedDepotPath;
    server.managedLastUsedRefresh = setInterval(() => {
      void touchManagedInstallation(depotPath);
    }, LAST_USED_REFRESH_INTERVAL);
  }

  languageClient.onRequest(
    TextDocumentContentRefreshRequest.method,
    (params: { uri: string }) => {
      routing.refreshTextDocumentContent(vscode.Uri.parse(params.uri));
      return null;
    },
  );

  server.showStatus("ready");
}

async function stopLanguageServer(server: FolderServer) {
  stopManagedLastUsedRefresh(server);
  // A client that never reached the `Running` state (e.g. one left stuck
  // in `Starting` by a start timeout) cannot be stopped: `stop()` throws,
  // which used to abort — and thereby permanently block — every restart.
  // `stopClient` falls back to disposing such clients, so the restart
  // always proceeds with a fresh client.
  await stopClient(server.client, TIMEOUTS.serverStop, (message) =>
    server.outputChannel.appendLine(message),
  );
}

async function restartLanguageServer(server: FolderServer) {
  if (deactivating || server.retired) {
    return;
  }
  if (server.client?.needsStop()) {
    server.showStatus("restarting");
  }
  await stopLanguageServer(server);
  await startLanguageServer(server);
}

function cancelServerStartup(server: FolderServer): void {
  // Kill an in-flight version preflight so a queued rerun can start
  // immediately; otherwise the rerun would wait for the preflight to finish,
  // which can take up to `TIMEOUTS.precompilation` while precompiling.
  void server.preflight.terminate().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    server.outputChannel.appendLine(
      `[jetls-client] Failed to terminate JETLS version check: ${message}.`,
    );
  });
  // Likewise kill a spawned server still waiting for its transport
  // connection; the transport turns this into a no-op once connected.
  server.cancelServerStartup?.();
  // And stop waiting for an in-flight managed setup, which can run for
  // minutes: the rerun queued above starts over from the current state.
  server.managedSetupAbort?.abort();
}

function requestServerRestart(server: FolderServer): void {
  if (deactivating || server.retired) {
    return;
  }
  const lifecycle = server.restartRunner.run();
  cancelServerStartup(server);
  void lifecycle.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    server.outputChannel.appendLine(
      `[jetls-client] Failed to restart language server: ${message}.`,
    );
  });
}

export function requestLanguageServerRestart(): void {
  for (const server of folderServers.values()) {
    requestServerRestart(server);
  }
}

// Set by `reinstallServer` and consumed by the next managed setup; it
// stays set until an installation succeeds, so a Retry after a failed
// reinstall still installs from scratch.
let forceManagedInstall = false;

function stopManagedLastUsedRefresh(server: FolderServer): void {
  if (server.managedLastUsedRefresh !== undefined) {
    clearInterval(server.managedLastUsedRefresh);
    server.managedLastUsedRefresh = undefined;
  }
}

/**
 * Reinstalls the managed JETLS from scratch: after a modal confirmation
 * the servers using it restart with the next managed setup forced to
 * install a fresh generation, ignoring the verified current one. Nothing
 * is deleted up front — superseded generations are cleaned up later — so
 * a failed reinstall leaves the previous installation in place and
 * surfaces the ordinary failure UI.
 */
export async function reinstallServer(): Promise<void> {
  if (deactivating) {
    return;
  }
  const managedServers = Array.from(folderServers.values()).filter((server) =>
    isManagedExecutable(getFolderServerConfig(server.folder).executable),
  );
  if (managedServers.length === 0) {
    void vscode.window.showInformationMessage(
      "JETLS managed installation is disabled by the executable setting.",
    );
    return;
  }
  const reinstallButton = "Reinstall";
  const choice = await vscode.window.showWarningMessage(
    "Reinstall the JETLS language server?",
    {
      modal: true,
      detail:
        "This reinstalls the pinned JETLS release into fresh managed " +
        "storage, which may require network access. The previous " +
        "installation is cleaned up automatically later.",
    },
    reinstallButton,
  );
  if (choice !== reinstallButton) {
    return;
  }
  forceManagedInstall = true;
  for (const server of managedServers) {
    requestServerRestart(server);
  }
}

export function restartOnServerConfigChange(
  event: vscode.ConfigurationChangeEvent,
): void {
  const servers = Array.from(folderServers.values()).filter(
    (server) =>
      affectsServerConfig(event, server.folder?.uri) &&
      hasServerConfigChanged(
        server.serverConfig,
        getFolderServerConfig(server.folder),
      ),
  );
  if (servers.length === 0) {
    return;
  }
  vscode.window.showInformationMessage(
    "JETLS configuration changed. Restarting language server...",
  );
  for (const server of servers) {
    requestServerRestart(server);
  }
}

async function disposeFolderServer(server: FolderServer): Promise<void> {
  server.retired = true;
  statusBar.clear(server.id);
  cancelServerStartup(server);
  await awaitWithTimeout(server.restartRunner.active, TIMEOUTS.serverStop);
  await stopLanguageServer(server);
}

function retireFolderServer(server: FolderServer): void {
  folderServers.delete(server.key);
  const teardown: Promise<void> = disposeFolderServer(server).finally(() => {
    if (retiringTeardowns.get(server.key) === teardown) {
      retiringTeardowns.delete(server.key);
    }
  });
  retiringTeardowns.set(server.key, teardown);
}

/**
 * Brings the servers in line with the workspace folders: one server per
 * top-level folder, or a single one when no folder is open. Removed
 * folders' servers stop and added folders' servers start; the others only
 * restart when the workspace switches between a single folder (whose
 * server also handles files outside it) and multiple folders.
 */
export function reconcileFolderServers(): void {
  if (deactivating) {
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const desiredFolders: (vscode.WorkspaceFolder | undefined)[] =
    folders.length === 0 ? [undefined] : getEffectiveWorkspaceFolders(folders);
  for (const folder of folders) {
    const outermost = getOutermostWorkspaceFolder(folder, folders);
    if (outermost !== folder) {
      outputChannel.appendLine(
        `[jetls-client] Workspace folder "${folder.name}" is nested in ` +
          `"${outermost.name}" and is handled by its server.`,
      );
    }
  }
  const desiredKeys = new Set(desiredFolders.map(getClientKey));
  for (const server of Array.from(folderServers.values())) {
    if (!desiredKeys.has(server.key)) {
      retireFolderServer(server);
    }
  }
  const unscoped = desiredFolders.length === 1;
  for (const folder of desiredFolders) {
    const key = getClientKey(folder);
    const existing = folderServers.get(key);
    if (existing) {
      existing.folder = folder;
      if (existing.client !== undefined && existing.unscoped !== unscoped) {
        requestServerRestart(existing);
      }
      continue;
    }
    const server = new FolderServer(folder);
    folderServers.set(key, server);
    void (retiringTeardowns.get(key) ?? Promise.resolve()).then(() =>
      requestServerRestart(server),
    );
  }
}

/**
 * Shows the output channel of the given server, falling back to the
 * extension-level channel when the server is unknown or omitted.
 */
export function showOutputChannel(serverId?: string): void {
  const server = Array.from(folderServers.values()).find(
    (candidate) => candidate.id === serverId,
  );
  (server?.outputChannel ?? outputChannel).show();
}

/** Resolves to `false` when the wait timed out before the promise settled. */
function awaitWithTimeout(
  promise: Promise<void> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (promise === undefined) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => resolve(false), timeoutMs);
    void promise
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timeoutHandle);
        resolve(true);
      });
  });
}

export async function shutdownServerLifecycle(): Promise<void> {
  deactivating = true;
  for (const setup of managedSetups.values()) {
    setup.abort();
  }
  const servers = Array.from(folderServers.values());
  folderServers.clear();
  await Promise.allSettled([
    ...servers.map(disposeFolderServer),
    ...retiringTeardowns.values(),
  ]);
  for (const channel of folderOutputChannels.values()) {
    channel.dispose();
  }
  folderOutputChannels.clear();
  routing?.dispose();
}
