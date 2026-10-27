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
  TMUX_MISSING_DETAIL,
  TMUX_REACHABLE_ARGS,
  TMUX_WHICH_ARGS,
  applyExecPlaceholders,
  attachInvocation,
  attachTerminalName,
  buildInjectedEnv,
  buildTmuxUnavailableEnv,
  execLabel,
  isOwnSessionName,
  parsePathLookup,
  pathBaseFor,
  resolveExecPrefix,
  resolvePlaceholderCommand,
  resolveTmuxPath,
  sessionNameFor,
  shouldHandleSessionOpen,
  shellProbeInvocation,
  tmuxCandidatePaths,
  tmuxDirToInject,
  tmuxInvocation,
} from "./server/tmux.ts";
import type { PrefixValues, TmuxRunResult } from "./server/tmux.ts";
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
  /**
   * Where tmux lives for one provider: the absolute binary **plus** the argv
   * prefix that reaches the namespace the agent runs in. Cached per provider id
   * ("" = the global default) and re-resolved when the settings change.
   */
  interface TmuxTarget {
    provider: string;
    path: string | null;
    tried: string[];
    /** raw prefix, placeholders still present; substituted per call */
    prefix: string[];
    label: string;
    /** tmux survives in the agent PATH inside the namespace (undefined = unknown) */
    reachableInPath?: boolean;
  }
  const targets = new Map<string, TmuxTarget>();
  const targetsInFlight = new Map<string, Promise<TmuxTarget>>();
  const settingsHandle = server.registerSettings(bridgeSettings);

  // `schema.parse({})` yields the declared defaults, so there is one source of
  // truth for them even before the host has stored a document.
  const defaultSettings = bridgeSettings.schema.parse({}) as BridgeSettings;
  let settingsCache: BridgeSettings | null = defaultSettings;
  const unsubscribeSettings = settingsHandle.subscribe((state) => {
    if (state.status !== "ready") return;
    const previous = settingsCache;
    if (
      previous &&
      (previous.tmuxPath !== state.values.tmuxPath ||
        JSON.stringify(previous.tmuxExec) !== JSON.stringify(state.values.tmuxExec) ||
        JSON.stringify(previous.providerTmuxExec) !== JSON.stringify(state.values.providerTmuxExec))
    ) {
      // tmuxPath / prefix changed: throw the cached resolutions away.
      targets.clear();
      targetsInFlight.clear();
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

  /** True when the host's Paseo session is gone (reload, shutdown, restart). */
  function channelGone(error: unknown): boolean {
    return stopped || /daemon client closed|client closed|channel closed/i.test(describeError(error));
  }

  /** Run one argv through a namespace prefix and normalise the failure shape. */
  async function execThrough(
    prefix: readonly string[],
    command: string,
    args: readonly string[],
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<TmuxRunResult> {
    const invocation = shellProbeInvocation(prefix, command, args);
    try {
      const result = await execCommand(invocation.command, invocation.args, {
        timeout: options?.timeout ?? 15000,
        maxBuffer: 8 * 1024 * 1024,
        signal: options?.signal,
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
  }

  /**
   * Resolve the tmux for one provider, **inside the namespace that provider's
   * agents run in**. A desktop daemon often has no tmux directory on PATH, and a
   * sandboxed provider has no host tmux at all, so a host-only lookup produced
   * sessions the agent could not reach. Probe order, all through the prefix:
   * `tmuxPath`, `command -v tmux`, then the fixed candidate list; each candidate
   * is proven by running `<candidate> -V`.
   */
  async function resolveTmuxFor(
    provider: string,
    values: PrefixValues,
    signal?: AbortSignal,
  ): Promise<TmuxTarget> {
    const cached = targets.get(provider);
    if (cached) return cached;
    const pending = targetsInFlight.get(provider);
    if (pending) return pending;
    const work = (async () => {
      const settings = await currentSettings();
      const rawPrefix = resolveExecPrefix({
        provider,
        providerTmuxExec: settings.providerTmuxExec,
        tmuxExec: settings.tmuxExec,
      });
      const prefix = applyExecPlaceholders(rawPrefix, values);
      const label = execLabel(prefix);
      const configured = typeof settings.tmuxPath === "string" ? settings.tmuxPath.trim() : "";
      const candidates = tmuxCandidatePaths(process.env.HOME);
      const which = await execThrough(prefix, "/bin/sh", [...TMUX_WHICH_ARGS], {
        timeout: 8000,
        signal,
      });
      const pathLookup = which.ok ? parsePathLookup(which.stdout) : null;
      // Whether tmux survives in the agent's own PATH is a separate question:
      // a login shell would answer it wrongly by restoring the profile PATH.
      const reachable = await execThrough(prefix, "/bin/sh", [...TMUX_REACHABLE_ARGS], {
        timeout: 8000,
        signal,
      });
      const reachableInPath = reachable.ok && parsePathLookup(reachable.stdout) !== null;
      const usable = new Set<string>();
      const toProbe =
        configured.length > 0 ? [configured] : [...(pathLookup ? [pathLookup] : []), ...candidates];
      for (const candidate of toProbe) {
        if (usable.has(candidate)) continue;
        const probed = await execThrough(prefix, candidate, ["-V"], { timeout: 8000, signal });
        if (probed.ok) usable.add(candidate);
      }
      const resolved = resolveTmuxPath({ configured, pathLookup, candidates }, (c) =>
        usable.has(c),
      );
      const target: TmuxTarget = {
        provider,
        path: resolved.path,
        tried: resolved.tried,
        prefix: rawPrefix,
        label,
        reachableInPath,
      };
      targets.set(provider, target);
      log(
        target.path
          ? `tmux resolved to ${target.path} (${label})`
          : `${TMUX_MISSING_DETAIL} (${label}); tried: ${target.tried.join(", ")}`,
      );
      return target;
    })().finally(() => {
      targetsInFlight.delete(provider);
    });
    targetsInFlight.set(provider, work);
    return work;
  }

  /** A target pinned to what the record says the session was created in. */
  function pinnedTarget(agentId: string): TmuxTarget | null {
    const record = bookkeeping.get(agentId);
    if (!record || !record.tmuxPath) return null;
    return {
      provider: record.provider,
      path: record.tmuxPath,
      tried: [],
      prefix: record.tmuxPrefix,
      label: record.tmuxLabel,
      // Unknown: a pinned target only ever runs tmux, it never builds agent env.
      reachableInPath: undefined,
    };
  }

  /**
   * Target for an RPC or a cleanup call. Prefers the namespace recorded when the
   * session was created; after a plugin reload (empty map) it falls back to the
   * configured prefixes and keeps the first one that actually has the session.
   */
  async function targetForAgent(
    agentId: string,
    sessionName: string,
    signal?: AbortSignal,
  ): Promise<{ target: TmuxTarget; triedLabels: string[] }> {
    const pinned = pinnedTarget(agentId);
    const settings = await currentSettings();
    const values = valuesFor(agentId, settings.sessionPrefix);
    if (pinned) return { target: pinned, triedLabels: [pinned.label] };
    const providers = ["", ...Object.keys(settings.providerTmuxExec ?? {})];
    let fallback: TmuxTarget | null = null;
    const triedLabels: string[] = [];
    for (const provider of providers) {
      const target = await resolveTmuxFor(provider, values, signal);
      if (!target.path) continue;
      if (!fallback) fallback = target;
      if (!triedLabels.includes(target.label)) triedLabels.push(target.label);
      if (await tmuxFor(target, values, signal).sessionExists(sessionName)) {
        bookkeeping.rememberOpened({
          agentId,
          sessionName,
          workspaceId: bookkeeping.get(agentId)?.workspaceId ?? null,
          cwd: bookkeeping.get(agentId)?.cwd ?? "",
          provider: target.provider,
          tmuxPath: target.path,
          tmuxPrefix: target.prefix,
          tmuxLabel: target.label,
        });
        return { target, triedLabels };
      }
    }
    const last = fallback ?? (await resolveTmuxFor("", values, signal));
    if (!triedLabels.includes(last.label)) triedLabels.push(last.label);
    return { target: last, triedLabels };
  }

  function valuesFor(agentId: string, sessionPrefix: string): PrefixValues {
    const record = bookkeeping.get(agentId);
    const derived = sessionNameFor(sessionPrefix, agentId);
    return {
      cwd: record?.cwd && derived === record.sessionName ? record.cwd : process.cwd(),
      agentId,
    };
  }

  const runTmuxFor =
    (target: TmuxTarget, values: PrefixValues, signal?: AbortSignal): TmuxRun =>
    async (args) => {
      if (!target.path) return { ok: false, stdout: "", stderr: TMUX_MISSING_DETAIL };
      const invocation = tmuxInvocation(
        target.path,
        applyExecPlaceholders(target.prefix, values),
        args,
      );
      try {
        const result = await execCommand(invocation.command, invocation.args, {
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

  const tmuxFor = (
    target: TmuxTarget,
    values: PrefixValues,
    signal?: AbortSignal,
  ): TmuxClientType => new TmuxClient(runTmuxFor(target, values, signal));

  // ── attach terminal ───────────────────────────────────────────────────────

  async function ensureAttachTerminal(
    paseo: Paseo,
    agentId: string,
    workspaceId: string,
    cwd: string,
    sessionName: string,
    target: TmuxTarget,
    values: PrefixValues,
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

    // Paseo spawns the terminal with the daemon's environment, so the command is
    // the resolved tmux **through the same prefix** - otherwise the tab shows a
    // host session the agent cannot reach, or fails outright in a container.
    if (!target.path) return null;
    const invocation = attachInvocation(
      target.path,
      applyExecPlaceholders(target.prefix, values),
      sessionName,
    );
    const handle = await paseo.terminals.create({
      workspaceId,
      cwd,
      name,
      command: invocation.command,
      args: invocation.args,
      size: { rows: ATTACH_TERMINAL_ROWS, cols: ATTACH_TERMINAL_COLS },
    });
    bookkeeping.rememberTerminal(agentId, handle.id, name);
    log(
      `opened attach terminal ${handle.id} for agent ${agentId} (${sessionName}, ${target.label}): ` +
        `${invocation.command} ${invocation.args.join(" ")}`,
    );
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
    target: TmuxTarget,
    values: PrefixValues,
  ): void {
    if (stopped || request.workspaceId === null) return;
    if (!bookkeeping.beginTerminal(request.agentId)) return;
    const workspaceId = request.workspaceId;
    const timer = setTimeout(() => {
      void ensureAttachTerminal(
        paseo,
        request.agentId,
        workspaceId,
        request.cwd,
        sessionName,
        target,
        values,
      )
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

      const values: PrefixValues = { cwd: request.cwd, agentId: request.agentId };
      const target = await resolveTmuxFor(request.provider, values, context.signal);
      const tmux = tmuxFor(target, values, context.signal);
      if (!target.path) {
        log(
          `${TMUX_MISSING_DETAIL}; agent ${request.agentId} gets an empty TMUX. ` +
            `Namespace: ${target.label}. Tried: ${target.tried.join(", ")}. Set tmuxPath to the ` +
            `absolute path inside that namespace, or tmuxExec/providerTmuxExec if tmux must be ` +
            `reached through a wrapper.`,
        );
        return {
          ...request,
          env: buildTmuxUnavailableEnv(baseEnv, {
            ...settings,
            tmuxPath: target.path,
            injectTmuxDir: false,
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

      // A fresh session means a fresh lifecycle: cleanup must be allowed again.
      cleanedUp.delete(request.agentId);

      bookkeeping.rememberOpened({
        agentId: request.agentId,
        sessionName,
        workspaceId: request.workspaceId,
        cwd: request.cwd,
        provider: target.provider,
        tmuxPath: target.path,
        tmuxPrefix: target.prefix,
        tmuxLabel: target.label,
      });

      log(
        `agent ${request.agentId} (${request.reason}) -> tmux ${sessionName} in ${target.label} ` +
          `pane ${ensured.handle.paneId}${ensured.handle.created ? " (created)" : " (reused)"}`,
      );

      if (settings.autoAttachTerminal) {
        scheduleAttachTerminal(context.paseo, request, sessionName, target, values);
      }

      // Only prepend a tmux directory when tmux is not already reachable inside
      // that namespace; a container that ships tmux needs no PATH rewrite, and
      // a host directory would be meaningless there.
      const injectDir = tmuxDirToInject(target);
      return {
        ...request,
        env: buildInjectedEnv(baseEnv, {
          socketPath: ensured.handle.socketPath,
          pid: ensured.handle.serverPid ?? process.pid,
          paneId: ensured.handle.paneId,
          sessionName,
          shellReadyDelayMs: settings.shellReadyDelayMs,
          stripAmosIdentity: settings.stripAmosIdentity,
          tmuxPath: target.path,
          injectTmuxDir: injectDir !== null,
        }),
      };
    } catch (error) {
      // A lifecycle hook must never break agent launch.
      log(`session_open hook failed for ${request.agentId}: ${describeError(error)}`);
      return;
    }
  });

  // ── cleanup ──────────────────────────────────────────────────────────────

  /**
   * Agent ids already cleaned up in this plugin instance. `agent.closed` and
   * `agent.archived` both fire for one archive, and a second pass would kill an
   * already-dead terminal and report a bogus tmux failure.
   */
  const cleanedUp = new Set<string>();

  async function handleAgentGone(
    paseo: Paseo,
    agentId: string,
    reason: "closed" | "archived",
  ): Promise<void> {
    if (stopped) return;
    if (cleanedUp.has(agentId)) return;
    cleanedUp.add(agentId);
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

      // Cleanup must use the namespace the session was created in, which the
      // record carries; after a reload the prefixes are re-probed instead.
      const { target, triedLabels } = await targetForAgent(agentId, sessionName);
      if (!target.path) {
        log(`${TMUX_MISSING_DETAIL}; nothing to kill for ${agentId} (tried: ${target.tried.join(", ")})`);
        bookkeeping.forget(agentId);
        return;
      }
      const tmux = tmuxFor(target, valuesFor(agentId, settings.sessionPrefix));
      if (!(await tmux.sessionExists(sessionName))) {
        // Not an error: the agent may never have had a session. Saying so keeps a
        // leaked session diagnosable instead of silent.
        log(`no tmux session ${sessionName} in ${triedLabels.join(", ")}; nothing to kill`);
        bookkeeping.forget(agentId);
        return;
      }

      const result = await tmux.killSession(sessionName);
      if (result.ok) log(`killed tmux session ${sessionName} in ${target.label} (${reason})`);
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
    const settings = await currentSettings();
    return { settings, name: sessionNameFor(settings.sessionPrefix, agentId) };
  }

  /** tmux client for an RPC, in the namespace the agent's session lives in. */
  async function clientForAgent(agentId: string, sessionName: string) {
    const settings = await currentSettings();
    const { target } = await targetForAgent(agentId, sessionName);
    const values = valuesFor(agentId, settings.sessionPrefix);
    return { target, values, tmux: tmuxFor(target, values) };
  }

  /** What namespace the panel should report. */
  function namespaceFields(target: TmuxTarget) {
    return {
      tmuxAvailable: Boolean(target.path),
      tmuxPath: target.path ?? "",
      tmuxExecLabel: target.label,
      tmuxTried: target.tried,
    };
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
        tmuxAvailable: false,
        tmuxPath: "",
        tmuxExecLabel: "host",
        tmuxTried: [],
        detail: "agent id is not usable as a tmux session name",
      };
    }
    const { target, tmux } = await clientForAgent(input.agentId, name);
    const unavailable = namespaceFields(target);
    if (!target.path) {
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
    const exists = await tmux.sessionExists(name);
    const panes = exists ? await tmux.listPanes(name) : [];
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
    if (!name) {
      return {
        agentId: input.agentId,
        sessionName: "",
        exists: false,
        panes: [],
        tmuxAvailable: false,
        tmuxPath: "",
        tmuxExecLabel: "host",
        tmuxTried: [],
        detail: "agent id is not usable as a tmux session name",
      };
    }
    const { target, tmux } = await clientForAgent(input.agentId, name);
    const unavailable = namespaceFields(target);
    if (!target.path) {
      return {
        agentId: input.agentId,
        sessionName: name,
        exists: false,
        panes: [],
        ...unavailable,
        detail: TMUX_MISSING_DETAIL,
      };
    }
    const exists = await tmux.sessionExists(name);
    const panes = exists ? await tmux.listPanes(name) : [];
    return { agentId: input.agentId, sessionName: name, exists, panes, ...unavailable };
  });

  server.handle(capturePaneRpc, async (input) => {
    const { settings, name } = await sessionFor(input.agentId);
    if (!name) return { paneId: input.paneId, text: "", lines: 0, detail: "unknown agent" };
    const { tmux } = await clientForAgent(input.agentId, name);
    if (!(await tmux.sessionExists(name))) {
      return { paneId: input.paneId, text: "", lines: 0, detail: `no tmux session ${name}` };
    }
    // The pane must belong to this agent's session, not merely to the server.
    const panes = await tmux.listPanes(name);
    if (!panes.some((pane) => pane.paneId === input.paneId)) {
      return { paneId: input.paneId, text: "", lines: 0, detail: "pane is not in this agent's session" };
    }
    const result = await tmux.capturePane(input.paneId, input.lines ?? settings.paneCaptureLines);
    if (!result.ok) return { paneId: input.paneId, text: "", lines: 0, detail: result.stderr };
    const text = result.stdout.replace(/\s+$/u, "");
    return { paneId: input.paneId, text, lines: text.length === 0 ? 0 : text.split("\n").length };
  });

  server.handle(selectPaneRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    if (!name) return { ok: false, paneId: input.paneId, detail: "unknown agent" };
    const { tmux } = await clientForAgent(input.agentId, name);
    const panes = await tmux.listPanes(name);
    if (!panes.some((pane) => pane.paneId === input.paneId)) {
      return { ok: false, paneId: input.paneId, detail: "pane is not in this agent's session" };
    }
    const result = await tmux.selectPane(input.paneId);
    return { ok: result.ok, paneId: input.paneId, detail: result.ok ? undefined : result.stderr };
  });

  server.handle(killPaneRpc, async (input) => {
    const { name } = await sessionFor(input.agentId);
    if (!name) return { ok: false, paneId: input.paneId, detail: "unknown agent" };
    const { tmux } = await clientForAgent(input.agentId, name);
    const panes = await tmux.listPanes(name);
    if (!panes.some((pane) => pane.paneId === input.paneId)) {
      return { ok: false, paneId: input.paneId, detail: "pane is not in this agent's session" };
    }
    const result = await tmux.killPane(input.paneId);
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
    const { target, values } = await clientForAgent(input.agentId, name);
    const terminalId = await ensureAttachTerminal(
      context.paseo,
      input.agentId,
      workspaceId,
      cwd,
      name,
      target,
      values,
    );
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
