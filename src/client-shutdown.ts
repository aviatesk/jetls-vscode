/** The lifecycle surface of `LanguageClient` used while shutting it down. */
export interface StoppableClient {
  needsStop(): boolean;
  stop(timeout: number): Promise<void>;
  dispose(timeout: number): Promise<void>;
}

/**
 * Stops a client ahead of a restart or shutdown, recovering from clients
 * that cannot be stopped: a client stuck in the `Starting` state (e.g.
 * left behind by a start timeout) makes `stop()` throw, which would
 * otherwise wedge every subsequent restart on the same stuck client.
 * Failures are logged and answered with a best-effort `dispose()`, so the
 * caller can always proceed to start a fresh client.
 */
export async function stopClient(
  client: StoppableClient | undefined,
  timeoutMs: number,
  appendLine: (message: string) => void,
): Promise<void> {
  if (client === undefined || !client.needsStop()) {
    return;
  }
  try {
    await client.stop(timeoutMs);
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLine(`[jetls-client] Failed to stop language client: ${message}.`);
  }
  try {
    await client.dispose(timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendLine(`[jetls-client] Failed to dispose language client: ${message}.`);
  }
}
