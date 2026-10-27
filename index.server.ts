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
  TMUX_MISSING_DETAIL,
  TMUX_WHICH_ARGS,
  attachArgs,
  attachTerminalName,
  buildInjectedEnv,
  buildTmuxUnavailableEnv,
  isOwnSessionName,
  parsePathLookup,
  pathBaseFor,
  resolvePlaceholderCommand,
  resolveTmuxPath,
  sessionNameFor,
  shouldHandleSessionOpen,
  tmuxCandidatePaths,
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
  // Set once the host tears the plugin down: the daemon IPC channel is closed
  // from then on, so any Paseo call would throw "Daemon client closed".
  let stopped = false;
  // Absolute tmux path resolved once per plugin instance (re-resolved when the
  // settings change). `tmuxBin` is what every tmux invocation actually runs.
  let tmuxBin = TMUX_BIN;
  let resolution: { path: string | null; tried: string[] } | null = null;
  let resolutionInFlight: Promise<{ path: string | null; tried: string[] }> | null = null;
  const settingsHandle = server.registerSettings(bridgeSettings);

  // `schema.parse({})` yields the declared defaults, so there is one source of
  // truth for them even before the host has stored a document.
  const defaultSettings = bridgeSettings.schema.parse({}) as BridgeSettings;
  let settingsCache: BridgeSettings | null = defaultSettings;
  const unsubscribeSettings = settingsHandle.subscribe((state) => {
    if (state.status !== "ready") return;
    if (settingsCache && settingsCache.tmuxPath !== state.values.tmuxPath) {
      // A tmuxPath override changed: throw the cached resolution away.
      resolution = null;
      resolutionInFlight = null;
    }
    settingsCache = state.values;
  });

  // The host only pushes settings on change, never as an initial state, so the
  // first use must read the stored document. Without this, a tmuxPath saved in
  // the app would be ignored after every daemon restart / plugin reload.
  let settingsReadFromHost = false;

  async function currentSettings(): Promise<BridgeSettings> {
    if (!settingsReadFromHost) {
      settingsReadFromHost = true;
      try {
        const state = await settingsHandle.read();
        if (state.status === "ready") {
          settingsCache = state.values;
        } else {
          log(`settings invalid (${state.status}): ${state.error}; using defaults`);
        }
      } catch (error) {
        log(`settings read failed: ${describeError(error)}; using defaults`);
      }
    }
    return settingsCache ?? defaultSettings;
  }

  /**
   * Resolve a usable tmux. A desktop daemon frequently starts with a PATH that
   * has no tmux directory, so `tmux` by name fails even when tmux is installed;
   * the user then sees a plugin that "does nothing". Probe order: the explicit
   * `tmuxPath` setting, `command -v tmux`, then a fixed candidate list. The
   * result is cached and every call - including the attach terminal's own
   * command - uses the absolute path.
   */
  async function resolveTmux(signal?: AbortSignal): Promise<{ path: string | null; tried: string[] }> {
    if (resolution) return resolution;
    if (resolutionInFlight) return resolutionInFlight;
    resolutionInFlight = (async () => {
      const settings = await currentSettings();
      const configured = typeof settings.tmuxPath === "string" ? settings.tmuxPath.trim() : "";
      const candidates = tmuxCandidatePaths(process.env.HOME);
      let pathLookup: string | null = null;
      if (configured.length === 0) {
        try {
          const probed = await execCommand("/bin/sh", [...TMUX_WHICH_ARGS], {
            timeout: 5000,
            signal,
          });
          pathLookup = parsePathLookup(probed.stdout);
        } catch {
          pathLookup = null;
        }
      }
      // Prove executability by running `<candidate> -V` rather than trusting that
      // a path exists: a stale symlink or a non-executable file must not win.
      const usable = new Set<string>();
      const toProbe =
        configured.length > 0 ? [configured] : [...(pathLookup ? [pathLookup] : []), ...candidates];
      for (const candidate of toProbe) {
        if (usable.has(candidate)) continue;
        try {
          await execCommand(candidate, ["-V"], { timeout: 5000, signal });
          usable.add(candidate);
        } catch {
          // not here, try the next one
        }
      }
      const resolved = resolveTmuxPath({ configured, pathLookup, candidates }, (c) =>
        usable.has(c),
      );
      resolution = resolved;
      if (resolved.path) tmuxBin = resolved.path;
      log(
        resolved.path
          ? `tmux resolved to ${resolved.path}`
          : `${TMUX_MISSING_DETAIL}; tried: ${resolved.tried.join(", ")}`,
      );
      return resolved;
    })().finally(() => {
      resolutionInFlight = null;
    });
    return resolutionInFlight;
  }

  /** True when the host's Paseo session is gone (reload, shutdown, restart). */
  function channelGone(error: unknown): boolean {
    return stopped || /daemon client closed|client closed|channel closed/i.test(describeError(error));
  }

  const runTmux =
    (signal?: AbortSignal): TmuxRun =>
    async (args) => {
      try {
        const result = await execCommand(tmuxBin, args, {
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
    if (stopped) return null;
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
        if (channelGone(error)) return record.terminalId;
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
      if (channelGone(error)) return null;
      log(`terminal list failed for ${agentId}: ${describeError(error)}`);
    }

    // The terminal process inherits the daemon environment, so it must run the
    // resolved absolute tmux too, not `tmux` by name.
    const resolved = await resolveTmux();
    const handle = await paseo.terminals.create({
      workspaceId,
      cwd,
      name,
      command: resolved.path ?? TMUX_BIN,
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
    if (stopped || request.workspaceId === null) return;
    if (!bookkeeping.beginTerminal(request.agentId)) return;
    const workspaceId = request.workspaceId;
    const timer = setTimeout(() => {
      void ensureAttachTerminal(paseo, request.agentId, workspaceId, request.cwd, sessionName)
        .catch((error: unknown) => {
          if (channelGone(error)) return;
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

      // The hook env replaces the daemon env key-by-key, so PATH must be built
      // on top of the daemon PATH rather than handed over as a lone directory.
      const pathBase = pathBaseFor(request.env.PATH, process.env.PATH);
      const baseEnv = pathBase ? { ...request.env, PATH: pathBase } : request.env;

      const sessionName = sessionNameFor(settings.sessionPrefix, request.agentId);
      if (!sessionName) {
        log(`refusing unsafe session name for agent ${request.agentId}`);
        return { ...request, env: buildTmuxUnavailableEnv(baseEnv, settings) };
      }

      const resolved = await resolveTmux(context.signal);
      const tmux = tmuxFor(context.signal);
      if (!resolved.path) {
        log(
          `${TMUX_MISSING_DETAIL}; agent ${request.agentId} gets an empty TMUX. ` +
            `Tried: ${resolved.tried.join(", ")}. Set tmuxPath to the absolute path if tmux ` +
            `lives somewhere else on this host.`,
        );
        return {
          ...request,
          env: buildTmuxUnavailableEnv(baseEnv, {
            ...settings,
            tmuxPath: resolved.path,
          }),
        };
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
        return { ...request, env: buildTmuxUnavailableEnv(baseEnv, settings) };
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
        env: buildInjectedEnv(baseEnv, {
          socketPath: ensured.handle.socketPath,
          pid: process.pid,
          paneId: ensured.handle.paneId,
          sessionName,
          shellReadyDelayMs: settings.shellReadyDelayMs,
          stripAmosIdentity: settings.stripAmosIdentity,
          // The agent must be able to run `tmux` itself (Amos checks
          // `command -v tmux`), so hand it the directory we resolved to.
          tmuxPath: resolved.path,
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
    if (stopped) return;
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
          if (!channelGone(error)) log(`terminal list failed for ${agentId}: ${describeError(error)}`);
        }
      }

      if (terminalId) {
        try {
          await paseo.terminals.ref(terminalId).kill();
          log(`killed attach terminal ${terminalId} for agent ${agentId}`);
        } catch (error) {
          if (!channelGone(error)) {
            log(`attach terminal kill failed for ${agentId}: ${describeError(error)}`);
          }
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
      if (!(await resolveTmux()).path) {
        bookkeeping.forget(agentId);
        return;
      }
      if (!(await tmux.sessionExists(sessionName))) {
        bookkeeping.forget(agentId);
        return;
      }

      const result = await tmux.killSession(sessionName);
      if (result.ok) log(`killed tmux session ${sessionName} (${reason})`);
      else log(`tmux kill-session ${sessionName} failed: ${result.stderr}`);

      bookkeeping.forget(agentId);
    } catch (error) {
      if (!channelGone(error)) log(`cleanup failed for ${agentId}: ${describeError(error)}`);
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
    // Every RPC runs tmux through the resolved absolute path, even when no
    // agent.session_open happened in this plugin instance.
    void resolveTmux();
    const settings = await currentSettings();
    return { settings, name: sessionNameFor(settings.sessionPrefix, agentId) };
  }

  server.handle(sessionStatusRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    const resolved = await resolveTmux();
    const unavailable = {
      tmuxAvailable: Boolean(resolved.path),
      tmuxPath: resolved.path ?? "",
      tmuxTried: resolved.tried,
    };
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
        ...unavailable,
        detail: "agent id is not usable as a tmux session name",
      };
    }
    if (!resolved.path) {
      return {
        agentId: input.agentId,
        sessionName: name,
        managed: Boolean(bookkeeping.get(input.agentId)),
        exists: false,
        paneCount: 0,
        terminalId: bookkeeping.get(input.agentId)?.terminalId ?? null,
        workspaceId: bookkeeping.get(input.agentId)?.workspaceId ?? null,
        cwd: bookkeeping.get(input.agentId)?.cwd ?? null,
        ...unavailable,
        detail: TMUX_MISSING_DETAIL,
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
      ...unavailable,
    };
  });

  server.handle(listPanesRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    const resolved = await resolveTmux();
    const unavailable = {
      tmuxAvailable: Boolean(resolved.path),
      tmuxPath: resolved.path ?? "",
      tmuxTried: resolved.tried,
    };
    if (!name) {
      return {
        agentId: input.agentId,
        sessionName: "",
        exists: false,
        panes: [],
        ...unavailable,
        detail: "agent id is not usable as a tmux session name",
      };
    }
    if (!resolved.path) {
      return {
        agentId: input.agentId,
        sessionName: name,
        exists: false,
        panes: [],
        ...unavailable,
        detail: TMUX_MISSING_DETAIL,
      };
    }
    const tmux = tmuxFor();
    const exists = await tmux.sessionExists(name);
    const panes = exists ? await tmux.listPanes(name) : [];
    return { agentId: input.agentId, sessionName: name, exists, panes, ...unavailable };
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
    // The daemon IPC channel closes with the plugin: stop touching Paseo after
    // this point, otherwise cleanup and pending attach terminals log
    // "Daemon client closed" noise on every reload/shutdown.
    stopped = true;
    unsubscribeSettings();
    offClosed();
    offArchived();
    bookkeeping.clear();
  };
}
