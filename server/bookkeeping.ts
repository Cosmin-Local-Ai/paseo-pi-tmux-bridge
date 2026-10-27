/**
 * In-daemon bookkeeping: agentId -> the tmux session and attach terminal this
 * plugin created for it.
 *
 * Paseo's `terminals.list()` payload carries only `id`, `workspaceId`, `cwd`
 * and `name`, and name round-tripping is not guaranteed by the SDK contract, so
 * this map is the source of truth for "which terminal did I create". The
 * workspace listing is used only as a secondary dedupe.
 */

export interface BridgeRecord {
  agentId: string;
  sessionName: string;
  workspaceId: string | null;
  cwd: string;
  terminalId: string | null;
  terminalName: string | null;
  openedAt: string;
  updatedAt: string;
}

export class BridgeBookkeeping {
  private records: Map<string, BridgeRecord> = new Map();
  private inFlight: Set<string> = new Set();

  get(agentId: string): BridgeRecord | undefined {
    return this.records.get(agentId);
  }

  has(agentId: string): boolean {
    return this.records.has(agentId);
  }

  get size(): number {
    return this.records.size;
  }

  list(): BridgeRecord[] {
    return [...this.records.values()];
  }

  rememberOpened(input: {
    agentId: string;
    sessionName: string;
    workspaceId: string | null;
    cwd: string;
  }): BridgeRecord {
    const now = new Date().toISOString();
    const previous = this.records.get(input.agentId);
    const record: BridgeRecord = {
      agentId: input.agentId,
      sessionName: input.sessionName,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      terminalId: previous?.terminalId ?? null,
      terminalName: previous?.terminalName ?? null,
      openedAt: previous?.openedAt ?? now,
      updatedAt: now,
    };
    this.records.set(input.agentId, record);
    return record;
  }

  rememberTerminal(agentId: string, terminalId: string, terminalName: string): void {
    const record = this.records.get(agentId);
    if (!record) {
      this.records.set(agentId, {
        agentId,
        sessionName: "",
        workspaceId: null,
        cwd: "",
        terminalId,
        terminalName,
        openedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    record.terminalId = terminalId;
    record.terminalName = terminalName;
    record.updatedAt = new Date().toISOString();
  }

  forget(agentId: string): BridgeRecord | undefined {
    const record = this.records.get(agentId);
    this.records.delete(agentId);
    this.inFlight.delete(agentId);
    return record;
  }

  /** Returns false when a terminal creation for this agent is already running. */
  beginTerminal(agentId: string): boolean {
    if (this.inFlight.has(agentId)) return false;
    this.inFlight.add(agentId);
    return true;
  }

  endTerminal(agentId: string): void {
    this.inFlight.delete(agentId);
  }

  clear(): void {
    this.records.clear();
    this.inFlight.clear();
  }
}
