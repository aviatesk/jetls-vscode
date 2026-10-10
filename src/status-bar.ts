import * as vscode from "vscode";

export type ServerStartupStatus =
  | "checking"
  | "starting"
  | "restarting"
  | "precompiling"
  | "ready"
  | "failed"
  | "crashed";

const SHOW_OUTPUT_COMMAND: vscode.Command = {
  command: "jetls-client.showOutput",
  title: "Show JETLS output",
};

type ServerStatusEntry =
  | { kind: "server"; status: ServerStartupStatus }
  | { kind: "managed-failure"; summary: string }
  | { kind: "managed-cancelled" };

interface ManagedProgressEntry {
  kind: "managed-progress";
  message: string;
  detail?: string;
}

type StatusEntry = ServerStatusEntry | ManagedProgressEntry;

function statusTier(entry: StatusEntry): number {
  switch (entry.kind) {
    case "managed-failure":
    case "managed-cancelled":
      return 0;
    case "managed-progress":
      return 1;
    case "server":
      if (entry.status === "failed" || entry.status === "crashed") {
        return 0;
      }
      return entry.status === "ready" ? 2 : 1;
  }
}

/**
 * Shows the startup status of every server in one item: a server that needs
 * attention wins over one in progress, which wins over ready ones. The
 * managed installation is shared by every server, so its progress is a
 * single entry of its own.
 */
export class StartupStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly entries = new Map<string, ServerStatusEntry>();
  private managedProgress: ManagedProgressEntry | undefined;
  private hideTimer: NodeJS.Timeout | undefined;
  private suppressed = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.item.name = "JETLS server startup status";
    this.item.command = SHOW_OUTPUT_COMMAND;
  }

  show(serverId: string, status: ServerStartupStatus): void {
    this.setEntry(serverId, { kind: "server", status });
  }

  /** Shows a spinner with a managed-installation progress message. */
  showManagedProgress(message: string): void {
    if (this.suppressed) {
      return;
    }
    this.managedProgress = { kind: "managed-progress", message };
    this.render();
  }

  /**
   * Updates only the tooltip with the latest installation output line;
   * a no-op unless the managed-progress spinner is showing.
   */
  showManagedProgressDetail(line: string): void {
    if (this.suppressed || this.managedProgress === undefined) {
      return;
    }
    this.managedProgress = { ...this.managedProgress, detail: line };
    this.render();
  }

  clearManagedProgress(): void {
    this.managedProgress = undefined;
    if (!this.suppressed) {
      this.render();
    }
  }

  /**
   * Shows a persistent managed-installation failure with a one-line
   * summary; clicking the item opens the output channel, which holds the
   * full failure details.
   */
  showManagedFailure(serverId: string, summary: string): void {
    this.setEntry(serverId, { kind: "managed-failure", summary });
  }

  /**
   * Shows that the managed installation was cancelled: a deliberate
   * stop rather than a failure, so the item keeps the stopped server
   * visible without the error styling.
   */
  showManagedCancelled(serverId: string): void {
    this.setEntry(serverId, { kind: "managed-cancelled" });
  }

  clear(serverId: string): void {
    this.entries.delete(serverId);
    if (!this.suppressed) {
      this.render();
    }
  }

  /** Ignore further status updates; used once deactivation has started. */
  suppress(): void {
    this.suppressed = true;
    this.clearHideTimer();
  }

  dispose(): void {
    this.clearHideTimer();
    this.entries.clear();
    this.item.dispose();
  }

  private setEntry(serverId: string, entry: ServerStatusEntry): void {
    if (this.suppressed) {
      return;
    }
    this.entries.set(serverId, entry);
    this.render();
  }

  private render(): void {
    this.clearHideTimer();
    let top: [string | undefined, StatusEntry] | undefined = this
      .managedProgress && [undefined, this.managedProgress];
    for (const candidate of this.entries) {
      if (top === undefined || statusTier(candidate[1]) < statusTier(top[1])) {
        top = candidate;
      }
    }
    if (top === undefined) {
      this.item.hide();
      return;
    }
    const [serverId, entry] = top;

    this.item.backgroundColor = undefined;
    this.item.command =
      serverId === undefined
        ? SHOW_OUTPUT_COMMAND
        : { ...SHOW_OUTPUT_COMMAND, arguments: [serverId] };
    switch (entry.kind) {
      case "managed-progress":
        this.item.text = `$(sync~spin) ${entry.message}`;
        this.item.tooltip =
          entry.detail === undefined
            ? "Setting up the managed JETLS installation."
            : `${entry.detail}\nClick to open the JETLS output.`;
        break;
      case "managed-failure":
        this.item.text = "$(error) Managed JETLS failed";
        this.item.tooltip = `${entry.summary}\nClick to open the JETLS output.`;
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
      case "managed-cancelled":
        this.item.text = "$(circle-slash) JETLS installation cancelled";
        this.item.tooltip =
          "The JETLS installation was cancelled. Restart the language server " +
          "to retry.\nClick to open the JETLS output.";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        break;
      case "server":
        this.renderServerStatus(entry.status);
        break;
    }
    this.item.show();

    // The top entry is ready only when every entry is.
    if (statusTier(entry) === 2) {
      this.hideTimer = setTimeout(() => {
        this.item.hide();
        this.hideTimer = undefined;
      }, 3000);
    }
  }

  private renderServerStatus(status: ServerStartupStatus): void {
    switch (status) {
      case "checking":
        this.item.text = "$(sync~spin) Checking JETLS...";
        this.item.tooltip = "Checking the JETLS executable and version.";
        break;
      case "starting":
        this.item.text = "$(sync~spin) Starting JETLS...";
        this.item.tooltip = "Starting the JETLS language server.";
        break;
      case "restarting":
        this.item.text = "$(sync~spin) Restarting JETLS...";
        this.item.tooltip = "Restarting the JETLS language server.";
        break;
      case "precompiling":
        this.item.text = "$(sync~spin) Precompiling JETLS...";
        this.item.tooltip =
          "Precompiling JETLS. The first startup may take longer.";
        break;
      case "ready":
        this.item.text = "$(check) JETLS ready";
        this.item.tooltip = "JETLS started successfully.";
        break;
      case "failed":
        this.item.text = "$(error) JETLS failed to start";
        this.item.tooltip =
          "JETLS failed to start. Click to open the JETLS output.";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
      case "crashed":
        this.item.text = "$(error) JETLS stopped";
        this.item.tooltip =
          "JETLS stopped unexpectedly. Click to open the JETLS output.";
        this.item.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
    }
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== undefined) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }
}
