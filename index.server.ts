import { execCommand } from "@getpaseo/plugin/server";
import type {
  PluginHookContext,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  bridgeSettings,
  capturePaneRpc,
  killPaneRpc,
  listPanesRpc,
  openAttachTerminalRpc,
  selectPaneRpc,
  sessionStatusRpc,
} from "./shared/contracts.ts";
import type { BridgeSettings } from "./shared/contracts.ts";
import { BridgeBookkeeping } from "./server/bookkeeping.ts";
import {
  AMOS_LAYOUT,
  ATTACH_TERMINAL_COLS,
  ATTACH_TERMINAL_ROWS,
  DEFAULT_LAYOUT,
  DEFAULT_PLACEHOLDER_CMD,
  DEFAULT_SESSION_PREFIX,
  FALLBACK_PLACEHOLDER_CMD,
  SESSION_COLS,
  SESSION_ENV_KEY,
  SESSION_ROWS,
  SHELL_READY_ENV_KEY,
  TMUX_BIN,
  attachArgs,
  attachTerminalName,
  buildInjectedEnv,
  buildTmuxUnavailableEnv,
  isOwnSessionName,
  resolvePlaceholderCommand,
  sessionNameFor,
  shouldHandleSessionOpen,
} from "./server/tmux.ts";
import type { TmuxClient as TmuxClientType, TmuxRun } from "./server/tmux.ts";
import { TmuxClient } from "./server/tmux.ts";

/**
 * pi-tmux-bridge
 *
 * Paseo launches Pi as a stdio RPC child, not inside a PTY, so a Pi agent has
 * no tmux environment. The Amos interactive-subagents extension gates every
 * pane operation on `!!process.env.TMUX && tmux on PATH` and always splits off
 * `process.env.TMUX_PANE`. Whatever the daemon inherited is therefore shared by
 * every agent — or absent entirely.
 *
 * This plugin gives each Pi agent its own tmux session with a long-lived
 * placeholder pane, advertises that pane through `TMUX`/`TMUX_PANE` on the
 * session-open env, and opens a Paseo terminal attached to the session so the
 * subagent panes are visible side by side.
 *
 * A lifecycle hook must never throw and must never block launch: every path
 * below is fail-soft.
 */

type Paseo = PluginHookContext["paseo"];

const LOG = "[pi-tmux-bridge]";

function log(message: string, extra?: unknown): void {
  if (extra === undefined) console.log(`${LOG} ${message}`);
  else console.log(`${LOG} ${message}`, extra);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function contribute(server: PluginServerContext): () => void {
  const bookkeeping = new BridgeBookkeeping();
  // Providers whose interactive sessions were skipped, so the skip is logged
  // once instead of on every session_open.
  const skippedProviders = new Set<string>();
  const settingsHandle = server.registerSettings(bridgeSettings);

  // `schema.parse({})` yields the declared defaults, so there is one source of
  // truth for them even before the host has stored a document.
  const defaultSettings = bridgeSettings.schema.parse({}) as BridgeSettings;
  let settingsCache: BridgeSettings | null = defaultSettings;
  const unsubscribeSettings = settingsHandle.subscribe((state) => {
    if (state.status === "ready") settingsCache = state.values;
  });

  async function currentSettings(): Promise<BridgeSettings> {
    if (settingsCache) return settingsCache;
    try {
      const state = await settingsHandle.read();
      if (state.status === "ready") {
        settingsCache = state.values;
        return state.values;
      }
      log(`settings invalid (${state.status}): ${state.error}`);
    } catch (error) {
      log(`settings read failed: ${describeError(error)}`);
    }
    return defaultSettings;
  }

  const runTmux =
    (signal?: AbortSignal): TmuxRun =>
    async (args) => {
      try {
        const result = await execCommand(TMUX_BIN, args, {
          timeout: 15000,
          maxBuffer: 8 * 1024 * 1024,
          signal,
        });
        return { ok: true, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as { stdout?: unknown; stderr?: unknown };
        const stderr =
          typeof failure.stderr === "string" && failure.stderr.trim().length > 0
            ? failure.stderr.trim()
            : describeError(error);
        return {
          ok: false,
          stdout: typeof failure.stdout === "string" ? failure.stdout : "",
          stderr,
        };
      }
    };

  const tmuxFor = (signal?: AbortSignal): TmuxClientType => new TmuxClient(runTmux(signal));

  // ── attach terminal ───────────────────────────────────────────────────────

  async function ensureAttachTerminal(
    paseo: Paseo,
    agentId: string,
    workspaceId: string,
    cwd: string,
    sessionName: string,
  ): Promise<string | null> {
    const name = attachTerminalName(agentId);
    const record = bookkeeping.get(agentId);

    // Bookkeeping is the source of truth: Paseo's terminal listing exposes only
    // id/workspaceId/cwd/name, and name round-tripping is not contractual.
    if (record?.terminalId) {
      try {
        const listed = await paseo.terminals.list({ workspaceId });
        if (listed.entries.some((entry) => entry.id === record.terminalId)) {
          return record.terminalId;
        }
      } catch (error) {
        log(`terminal list failed for ${agentId}: ${describeError(error)}`);
        return record.terminalId;
      }
    }

    try {
      const listed = await paseo.terminals.list({ workspaceId });
      const byName = listed.entries.find((entry) => entry.name === name);
      if (byName) {
        bookkeeping.rememberTerminal(agentId, byName.id, name);
        return byName.id;
      }
    } catch (error) {
      log(`terminal list failed for ${agentId}: ${describeError(error)}`);
    }

    const handle = await paseo.terminals.create({
      workspaceId,
      cwd,
      name,
      command: TMUX_BIN,
      args: attachArgs(sessionName),
      size: { rows: ATTACH_TERMINAL_ROWS, cols: ATTACH_TERMINAL_COLS },
    });
    bookkeeping.rememberTerminal(agentId, handle.id, name);
    log(`opened attach terminal ${handle.id} for agent ${agentId} (${sessionName})`);
    return handle.id;
  }

  /**
   * Never awaited by the hook: terminal creation must not block or fail an
   * agent launch. `beginTerminal` collapses create/resume/refresh bursts.
   */
  function scheduleAttachTerminal(
    paseo: Paseo,
    request: PluginSessionOpenRequest,
    sessionName: string,
  ): void {
    if (request.workspaceId === null) return;
    if (!bookkeeping.beginTerminal(request.agentId)) return;
    const workspaceId = request.workspaceId;
    const timer = setTimeout(() => {
      void ensureAttachTerminal(paseo, request.agentId, workspaceId, request.cwd, sessionName)
        .catch((error: unknown) => {
          log(`attach terminal failed for ${request.agentId}: ${describeError(error)}`);
        })
        .finally(() => bookkeeping.endTerminal(request.agentId));
    }, 0);
    if (typeof timer.unref === "function") timer.unref();
  }

  // ── before("agent.session_open") ─────────────────────────────────────────

  server.before("agent.session_open", async (input, context) => {
    const request = input.request;
    try {
      const settings = await currentSettings();
      if (!settings.enabled) return;
      const guardOptions = {
        extraProviderIds: settings.piProviders,
        autoDetect: settings.autoDetectPiProviders,
      };
      if (!shouldHandleSessionOpen(request, guardOptions)) {
        if (
          request.purpose === "interactive" &&
          !skippedProviders.has(request.provider) &&
          settings.piProviders.length === 0
        ) {
          skippedProviders.add(request.provider);
          log(
            `skipping provider ${JSON.stringify(request.provider)}: it is not a Pi provider. ` +
              `Add it to the piProviders setting if it launches pi.`,
          );
        }
        return;
      }

      const sessionName = sessionNameFor(settings.sessionPrefix, request.agentId);
      if (!sessionName) {
        log(`refusing unsafe session name for agent ${request.agentId}`);
        return { ...request, env: buildTmuxUnavailableEnv(request.env, settings) };
      }

      const tmux = tmuxFor(context.signal);
      if (!(await tmux.probe())) {
        log(`tmux is not on PATH; agent ${request.agentId} gets an empty TMUX`);
        return { ...request, env: buildTmuxUnavailableEnv(request.env, settings) };
      }

      const ensured = await tmux.ensureSession({
        name: sessionName,
        cwd: request.cwd,
        cols: SESSION_COLS,
        rows: SESSION_ROWS,
        placeholder: resolvePlaceholderCommand(settings.placeholderCmd, process.env),
        layout: settings.layout || AMOS_LAYOUT,
      });

      if (!ensured.ok) {
        log(`tmux session ${sessionName} unavailable (${ensured.stage}): ${ensured.message}`);
        return { ...request, env: buildTmuxUnavailableEnv(request.env, settings) };
      }

      bookkeeping.rememberOpened({
        agentId: request.agentId,
        sessionName,
        workspaceId: request.workspaceId,
        cwd: request.cwd,
      });

      log(
        `agent ${request.agentId} (${request.reason}) -> tmux ${sessionName} ` +
          `pane ${ensured.handle.paneId}${ensured.handle.created ? " (created)" : " (reused)"}`,
      );

      if (settings.autoAttachTerminal) {
        scheduleAttachTerminal(context.paseo, request, sessionName);
      }

      return {
        ...request,
        env: buildInjectedEnv(request.env, {
          socketPath: ensured.handle.socketPath,
          pid: process.pid,
          paneId: ensured.handle.paneId,
          sessionName,
          shellReadyDelayMs: settings.shellReadyDelayMs,
          stripAmosIdentity: settings.stripAmosIdentity,
        }),
      };
    } catch (error) {
      // A lifecycle hook must never break agent launch.
      log(`session_open hook failed for ${request.agentId}: ${describeError(error)}`);
      return;
    }
  });

  // ── cleanup ──────────────────────────────────────────────────────────────

  async function handleAgentGone(
    paseo: Paseo,
    agentId: string,
    reason: "closed" | "archived",
  ): Promise<void> {
    try {
      const settings = await currentSettings();
      const record = bookkeeping.get(agentId);

      // The bookkeeping map is per plugin instance, so after `plugin reload` or a
      // daemon restart it is empty while the tmux session and terminal are still
      // alive. Both are named deterministically from the agent id, so cleanup can
      // still recover instead of leaking a session forever.
      const derivedSession = sessionNameFor(settings.sessionPrefix, agentId);
      const sessionName = record?.sessionName ?? derivedSession ?? "";

      let terminalId = record?.terminalId ?? null;
      if (!terminalId) {
        try {
          const listed = await paseo.terminals.list();
          const name = attachTerminalName(agentId);
          terminalId = listed.entries.find((entry) => entry.name === name)?.id ?? null;
        } catch (error) {
          log(`terminal list failed for ${agentId}: ${describeError(error)}`);
        }
      }

      if (terminalId) {
        try {
          await paseo.terminals.ref(terminalId).kill();
          log(`killed attach terminal ${terminalId} for agent ${agentId}`);
        } catch (error) {
          log(`attach terminal kill failed for ${agentId}: ${describeError(error)}`);
        }
      }

      if (!settings.killOnClose || !sessionName) {
        bookkeeping.forget(agentId);
        return;
      }

      // Guard: only a name this plugin derived from this agent id may be killed.
      if (!isOwnSessionName(sessionName, settings.sessionPrefix, agentId)) {
        log(`refusing to kill non-bridge session ${sessionName}`);
        bookkeeping.forget(agentId);
        return;
      }

      const tmux = tmuxFor();
      if (!(await tmux.sessionExists(sessionName))) {
        bookkeeping.forget(agentId);
        return;
      }

      const result = await tmux.killSession(sessionName);
      if (result.ok) log(`killed tmux session ${sessionName} (${reason})`);
      else log(`tmux kill-session ${sessionName} failed: ${result.stderr}`);

      bookkeeping.forget(agentId);
    } catch (error) {
      log(`cleanup failed for ${agentId}: ${describeError(error)}`);
    }
  }

  const offClosed = server.on("agent.closed", (event, context) => {
    void handleAgentGone(context.paseo, event.agent.id, "closed");
  });
  const offArchived = server.on("agent.archived", (event, context) => {
    void handleAgentGone(context.paseo, event.agent.id, "archived");
  });

  // ── RPC ──────────────────────────────────────────────────────────────────

  async function sessionFor(agentId: string): Promise<{ settings: BridgeSettings; name: string | null }> {
    const settings = await currentSettings();
    return { settings, name: sessionNameFor(settings.sessionPrefix, agentId) };
  }

  server.handle(sessionStatusRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    if (!name) {
      return {
        agentId: input.agentId,
        sessionName: "",
        managed: false,
        exists: false,
        paneCount: 0,
        terminalId: null,
        workspaceId: null,
        cwd: null,
        detail: "agent id is not usable as a tmux session name",
      };
    }
    const record = bookkeeping.get(input.agentId);
    const exists = await tmuxFor().sessionExists(name);
    const panes = exists ? await tmuxFor().listPanes(name) : [];
    return {
      agentId: input.agentId,
      sessionName: name,
      managed: Boolean(record),
      exists,
      paneCount: panes.length,
      terminalId: record?.terminalId ?? null,
      workspaceId: record?.workspaceId ?? null,
      cwd: record?.cwd ?? null,
    };
  });

  server.handle(listPanesRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    if (!name) {
      return {
        agentId: input.agentId,
        sessionName: "",
        exists: false,
        panes: [],
        detail: "agent id is not usable as a tmux session name",
      };
    }
    const tmux = tmuxFor();
    const exists = await tmux.sessionExists(name);
    const panes = exists ? await tmux.listPanes(name) : [];
    return { agentId: input.agentId, sessionName: name, exists, panes };
  });

  server.handle(capturePaneRpc, async (input) => {
    const { settings, name } = await sessionFor(input.agentId);
    if (!name) return { paneId: input.paneId, text: "", lines: 0, detail: "unknown agent" };
    if (!(await tmuxFor().sessionExists(name))) {
      return { paneId: input.paneId, text: "", lines: 0, detail: `no tmux session ${name}` };
    }
    // The pane must belong to this agent's session, not merely to the server.
    const panes = await tmuxFor().listPanes(name);
    if (!panes.some((pane) => pane.paneId === input.paneId)) {
      return { paneId: input.paneId, text: "", lines: 0, detail: "pane is not in this agent's session" };
    }
    const result = await tmuxFor().capturePane(
      input.paneId,
      input.lines ?? settings.paneCaptureLines,
    );
    if (!result.ok) return { paneId: input.paneId, text: "", lines: 0, detail: result.stderr };
    const text = result.stdout.replace(/\s+$/u, "");
    return { paneId: input.paneId, text, lines: text.length === 0 ? 0 : text.split("\n").length };
  });

  server.handle(selectPaneRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    if (!name) return { ok: false, paneId: input.paneId, detail: "unknown agent" };
    const panes = await tmuxFor().listPanes(name);
    if (!panes.some((pane) => pane.paneId === input.paneId)) {
      return { ok: false, paneId: input.paneId, detail: "pane is not in this agent's session" };
    }
    const result = await tmuxFor().selectPane(input.paneId);
    return { ok: result.ok, paneId: input.paneId, detail: result.ok ? undefined : result.stderr };
  });

  server.handle(killPaneRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    if (!name) return { ok: false, paneId: input.paneId, detail: "unknown agent" };
    const panes = await tmuxFor().listPanes(name);
    if (!panes.some((pane) => pane.paneId === input.paneId)) {
      return { ok: false, paneId: input.paneId, detail: "pane is not in this agent's session" };
    }
    const result = await tmuxFor().killPane(input.paneId);
    return { ok: result.ok, paneId: input.paneId, detail: result.ok ? undefined : result.stderr };
  });

  server.handle(openAttachTerminalRpc, async (input, context) => {
    const { name } = await sessionFor(input.agentId);
    if (!name) return { ok: false, terminalId: null, sessionName: "", detail: "unknown agent" };
    const record = bookkeeping.get(input.agentId);
    let workspaceId = record?.workspaceId ?? null;
    let cwd = record?.cwd ?? null;
    if (!workspaceId || !cwd) {
      const handle = context.paseo.agents.ref(input.agentId);
      try {
        await handle.refresh();
      } catch (error) {
        return {
          ok: false,
          terminalId: null,
          sessionName: name,
          detail: `agent lookup failed: ${describeError(error)}`,
        };
      }
      workspaceId = handle.workspaceId;
      cwd = handle.cwd;
    }
    if (!workspaceId || !cwd) {
      return {
        ok: false,
        terminalId: null,
        sessionName: name,
        detail: "this agent has no workspace, so no terminal can be opened",
      };
    }
    const terminalId = await ensureAttachTerminal(context.paseo, input.agentId, workspaceId, cwd, name);
    return { ok: Boolean(terminalId), terminalId, sessionName: name };
  });

  log(
    `ready (prefix=${JSON.stringify(defaultSettings.sessionPrefix)} ` +
      `layout=${JSON.stringify(defaultSettings.layout ?? DEFAULT_LAYOUT)} ` +
      `placeholder=${JSON.stringify(defaultSettings.placeholderCmd ?? DEFAULT_PLACEHOLDER_CMD)} ` +
      `fallback=${JSON.stringify(FALLBACK_PLACEHOLDER_CMD)} ` +
      `${SHELL_READY_ENV_KEY}=${defaultSettings.shellReadyDelayMs} ` +
      `${SESSION_ENV_KEY}=${SESSION_ENV_KEY})`,
  );

  return () => {
    unsubscribeSettings();
    offClosed();
    offArchived();
    bookkeeping.clear();
  };
}
