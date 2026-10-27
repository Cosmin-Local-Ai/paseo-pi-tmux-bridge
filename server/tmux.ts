/**
 * tmux command builders, output parsers and env construction.
 *
 * Deliberately free of any `@getpaseo/*` or `zod` import so the pure parts can
 * be unit-tested with plain `node --test` (Node type-stripping) without the
 * Paseo SDK on the module path.
 *
 * Injection guard: every value that reaches a tmux `-t`/`-P -F` argv slot is
 * validated here. Session names are always derived from a configured prefix
 * plus a Paseo agent id — never supplied by the plugin client.
 */

export const TMUX_BIN = "tmux";

export const DEFAULT_SESSION_PREFIX = "paseo-";
export const DEFAULT_LAYOUT = "even-horizontal";
export const DEFAULT_PLACEHOLDER_CMD = "$SHELL -l";
export const FALLBACK_PLACEHOLDER_CMD = "tail -f /dev/null";
export const DEFAULT_SHELL_READY_DELAY_MS = 2000;
export const DEFAULT_PANE_CAPTURE_LINES = 15;
/** Mirrors Amos's own SUBAGENT_TMUX_LAYOUT constant (pi-extension/subagents/tmux.ts:74). */
export const AMOS_LAYOUT = "even-horizontal";

/** Placeholder session geometry; the attach terminal re-fits it on attach. */
export const SESSION_COLS = 220;
export const SESSION_ROWS = 60;
export const ATTACH_TERMINAL_ROWS = 50;
export const ATTACH_TERMINAL_COLS = 220;

/** Env key the bridge sets so other tooling can find the session for an agent. */
export const SESSION_ENV_KEY = "PASEO_TMUX_SESSION";
/** Amos reads this to wait for a fresh pane's shell before typing into it. */
export const SHELL_READY_ENV_KEY = "PI_SUBAGENT_SHELL_READY_DELAY_MS";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PANE_ID = /^%[0-9]{1,9}$/;
const SAFE_LAYOUT = /^[a-z][a-z0-9-]{0,31}$/;

export function isSafeSessionName(value: string): boolean {
  return typeof value === "string" && SAFE_NAME.test(value);
}

export function isSafeAgentId(value: string): boolean {
  return typeof value === "string" && SAFE_AGENT_ID.test(value);
}

export function isSafePaneId(value: string): boolean {
  return typeof value === "string" && SAFE_PANE_ID.test(value);
}

export function isSafeLayout(value: string): boolean {
  return typeof value === "string" && SAFE_LAYOUT.test(value);
}

/**
 * `paseo-` + agentId. Returns null when the result would not be a safe tmux
 * target, which lets callers fall soft instead of handing a hostile name to
 * `tmux -t`.
 */
export function sessionNameFor(prefix: string, agentId: string): string | null {
  if (typeof prefix !== "string" || typeof agentId !== "string") return null;
  if (prefix.length === 0 || prefix.length > 32) return null;
  if (!isSafeAgentId(agentId)) return null;
  const name = `${prefix}${agentId}`;
  return isSafeSessionName(name) ? name : null;
}

/**
 * Cleanup guard: a session may only be killed when its name is exactly this
 * plugin's prefix plus this agent's id. That makes it impossible to kill a
 * session the bridge did not create.
 */
export function isOwnSessionName(name: string, prefix: string, agentId: string): boolean {
  if (typeof name !== "string" || typeof prefix !== "string") return false;
  if (prefix.length === 0) return false;
  if (!name.startsWith(prefix)) return false;
  return name === `${prefix}${agentId}` && isOwnSessionNameShape(name, prefix);
}

function isOwnSessionNameShape(name: string, prefix: string): boolean {
  if (!isSafeSessionName(name)) return false;
  const rest = name.slice(prefix.length);
  return isSafeAgentId(rest);
}

/** Provider id of the built-in Pi provider. */
export const PI_PROVIDER_ID = "pi";

/**
 * Paseo lets a user declare a custom agent provider with `extends: "pi"`, for
 * example `pi-recovery`. `agent.session_open` reports the *derived* provider id
 * (`packages/server/src/server/agent/agent-manager.ts` sends `client.provider`),
 * never `pi`, so an exact `provider === "pi"` match silently disables the bridge
 * for every agent of such a provider. A `pi` token in the id recognises them.
 * The token is delimited, so `pilot` and `openapi` do not match.
 */
const PI_PROVIDER_TOKEN = /(?:^|[-_.])pi(?:[-_.]|$)/;

export interface PiProviderMatchOptions {
  /** Exact provider ids to treat as Pi regardless of the heuristic. */
  extraProviderIds?: readonly string[];
  /** Default true: recognise `pi`-derived provider ids such as `pi-recovery`. */
  autoDetect?: boolean;
}

export function isPiProviderId(
  provider: string,
  options: PiProviderMatchOptions = {},
): boolean {
  if (typeof provider !== "string" || provider.length === 0) return false;
  if (provider === PI_PROVIDER_ID) return true;
  if ((options.extraProviderIds ?? []).includes(provider)) return true;
  return (options.autoDetect ?? true) && PI_PROVIDER_TOKEN.test(provider);
}

/** Only interactive Pi sessions get a tmux bridge. */
export function shouldHandleSessionOpen(
  request: { provider: string; purpose: string },
  options: PiProviderMatchOptions = {},
): boolean {
  return request.purpose === "interactive" && isPiProviderId(request.provider, options);
}

/**
 * Amos identity variables. A Paseo agent is always a top-level Pi session, but
 * Paseo passes the daemon's environment down, so a daemon started from inside
 * an Amos subagent pane hands its identity to every agent. Amos's self-spawn
 * guard then refuses `subagent({ agent: "worker" })` with "You are the worker
 * agent", which looks exactly like the bridge doing nothing.
 */
export const AMOS_IDENTITY_ENV_KEYS: readonly string[] = [
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_ALLOWED",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_SURFACE",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
];

export function stripAmosIdentity(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (AMOS_IDENTITY_ENV_KEYS.includes(key)) continue;
    next[key] = value;
  }
  return next;
}

/**
 * Replace `$SHELL` with a concrete shell path. tmux runs the placeholder
 * through the default shell, but resolving it here keeps the argv element
 * predictable and lets us fall back to a command that cannot exit.
 */
export function resolvePlaceholderCommand(
  configured: string,
  env: Record<string, string | undefined>,
): string {
  const raw = typeof configured === "string" ? configured.trim() : "";
  if (raw.length === 0) return FALLBACK_PLACEHOLDER_CMD;
  const shell = typeof env.SHELL === "string" && env.SHELL.length > 0 ? env.SHELL : "/bin/sh";
  const resolved = raw.replaceAll("$SHELL", shell).replaceAll("${SHELL}", shell).trim();
  return resolved.length > 0 ? resolved : FALLBACK_PLACEHOLDER_CMD;
}

// ── argv builders (everything after the `tmux` binary) ──────────────────────

export function hasSessionCmd(name: string): string[] {
  return ["has-session", "-t", name];
}

export function newSessionCmd(options: {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  placeholder: string;
}): string[] {
  return [
    "new-session",
    "-d",
    "-s",
    options.name,
    "-c",
    options.cwd,
    "-x",
    String(options.cols),
    "-y",
    String(options.rows),
    options.placeholder,
  ];
}

export function selectLayoutCmd(name: string, layout: string): string[] {
  return ["select-layout", "-t", name, layout];
}

export function displayPaneIdCmd(name: string): string[] {
  return ["display-message", "-p", "-t", name, "#{pane_id}"];
}

export function displaySocketPathCmd(): string[] {
  return ["display-message", "-p", "#{socket_path}"];
}

export const PANE_FORMAT =
  "#{pane_id}|#{pane_index}|#{pane_current_command}|#{pane_pid}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}";

export function listPanesCmd(name: string): string[] {
  return ["list-panes", "-t", name, "-F", PANE_FORMAT];
}

export function capturePaneCmd(paneId: string, lines: number): string[] {
  const bounded = Math.max(1, Math.min(2000, Math.trunc(lines) || 1));
  return ["capture-pane", "-p", "-t", paneId, "-S", `-${bounded}`];
}

export function selectPaneCmd(paneId: string): string[] {
  return ["select-pane", "-t", paneId];
}

export function killPaneCmd(paneId: string): string[] {
  return ["kill-pane", "-t", paneId];
}

export function killSessionCmd(name: string): string[] {
  return ["kill-session", "-t", name];
}

export function attachArgs(name: string): string[] {
  return ["attach", "-t", name];
}

export function attachTerminalName(agentId: string): string {
  return `pi-tmux:${agentId}`;
}

// ── output parsers ─────────────────────────────────────────────────────────

export interface TmuxPane {
  paneId: string;
  paneIndex: string;
  paneCurrentCommand: string;
  panePid: string;
  paneTitle: string;
  paneWidth: string;
  paneHeight: string;
  active: boolean;
}

export function parsePaneRows(stdout: string): TmuxPane[] {
  return stdout.split("\n").flatMap((line) => {
    const cells = line.trim().split("|");
    if (cells.length < 8 || !isSafePaneId(cells[0] ?? "")) return [];
    return [
      {
        paneId: cells[0] as string,
        paneIndex: cells[1] as string,
        paneCurrentCommand: cells[2] as string,
        panePid: cells[3] as string,
        paneTitle: cells[4] as string,
        paneWidth: cells[5] as string,
        paneHeight: cells[6] as string,
        active: cells[7] === "1",
      },
    ];
  });
}

export function parsePaneId(stdout: string): string | null {
  const value = (stdout ?? "").trim();
  return isSafePaneId(value) ? value : null;
}

export function parseSocketPath(stdout: string): string | null {
  const value = (stdout ?? "").trim();
  if (value.length === 0 || value.length > 512) return null;
  if (/[\r\n]/.test(value)) return null;
  return value;
}

// ── env construction ───────────────────────────────────────────────────────

export interface InjectedEnvOptions {
  socketPath: string;
  /** pid field of TMUX; Amos never validates it, tmux clients only re-parse the socket. */
  pid: number;
  paneId: string;
  sessionName: string;
  shellReadyDelayMs: number;
  /** Default true: never let the daemon's Amos identity reach a top-level agent. */
  stripAmosIdentity?: boolean;
}

/**
 * `env` from `agent.session_open` is NOT deep-merged by Paseo, so the existing
 * env must always be spread first.
 */
export function buildInjectedEnv(
  base: Record<string, string>,
  options: InjectedEnvOptions,
): Record<string, string> {
  return {
    ...(options.stripAmosIdentity === false ? base : stripAmosIdentity(base)),
    TMUX: `${options.socketPath},${options.pid},0`,
    TMUX_PANE: options.paneId,
    [SESSION_ENV_KEY]: options.sessionName,
    [SHELL_READY_ENV_KEY]: String(options.shellReadyDelayMs),
  };
}

/**
 * Fail-soft env. `TMUX` becomes an empty string, which is falsy in JS, so Amos
 * reports its own "tmux is required for subagents" message instead of
 * splitting from a stale pane the daemon happened to inherit. `TMUX_PANE` is
 * cleared for the same reason.
 */
export function buildTmuxUnavailableEnv(
  base: Record<string, string>,
  options: { shellReadyDelayMs: number; stripAmosIdentity?: boolean },
): Record<string, string> {
  return {
    ...(options.stripAmosIdentity === false ? base : stripAmosIdentity(base)),
    TMUX: "",
    TMUX_PANE: "",
    [SESSION_ENV_KEY]: "",
    [SHELL_READY_ENV_KEY]: String(options.shellReadyDelayMs),
  };
}

// ── runner ─────────────────────────────────────────────────────────────────

export interface TmuxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable so the client below is testable without spawning tmux. */
export type TmuxRun = (args: string[]) => Promise<TmuxRunResult>;

export interface EnsureSessionOptions {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  placeholder: string;
  layout: string;
}

export interface SessionHandle {
  paneId: string;
  socketPath: string;
  created: boolean;
}

export interface TmuxFailure {
  ok: false;
  stage: "probe" | "has-session" | "new-session" | "pane-id" | "socket" | "name";
  message: string;
}

export type EnsureSessionResult = { ok: true; handle: SessionHandle } | TmuxFailure;

export class TmuxClient {
  private readonly run: TmuxRun;

  constructor(run: TmuxRun) {
    this.run = run;
  }

  /** Cheap availability probe; Amos gates on `!!TMUX && command -v tmux`. */
  async probe(): Promise<boolean> {
    const res = await this.run(["-V"]);
    return res.ok;
  }

  /**
   * Create-or-reuse the per-agent session and return the pane id to advertise.
   * Idempotent: on resume/refresh the existing session is reused and its
   * current pane id re-read. It never kills the session.
   */
  async ensureSession(options: EnsureSessionOptions): Promise<EnsureSessionResult> {
    if (!isSafeSessionName(options.name)) {
      return { ok: false, stage: "name", message: `unsafe session name: ${options.name}` };
    }
    let created = false;
    const existing = await this.run(hasSessionCmd(options.name));
    if (!existing.ok) {
      const primary = await this.run(
        newSessionCmd({
          name: options.name,
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          placeholder: options.placeholder,
        }),
      );
      if (!primary.ok) {
        const fallback = await this.run(
          newSessionCmd({
            name: options.name,
            cwd: options.cwd,
            cols: options.cols,
            rows: options.rows,
            placeholder: FALLBACK_PLACEHOLDER_CMD,
          }),
        );
        if (!fallback.ok) {
          return {
            ok: false,
            stage: "new-session",
            message: `${primary.stderr || primary.stdout || fallback.stderr || "new-session failed"}`,
          };
        }
      }
      created = true;
    }

    if (isSafeLayout(options.layout)) {
      // Cosmetic; a layout failure must not block the launch.
      await this.run(selectLayoutCmd(options.name, options.layout));
    }

    const paneRes = await this.run(displayPaneIdCmd(options.name));
    const paneId = parsePaneId(paneRes.stdout);
    if (!paneId) {
      return { ok: false, stage: "pane-id", message: paneRes.stderr || "no pane id for session" };
    }

    const socketRes = await this.run(displaySocketPathCmd());
    const socketPath = parseSocketPath(socketRes.stdout);
    if (!socketPath) {
      return { ok: false, stage: "socket", message: socketRes.stderr || "no tmux socket path" };
    }

    return { ok: true, handle: { paneId, socketPath, created } };
  }

  async sessionExists(name: string): Promise<boolean> {
    if (!isSafeSessionName(name)) return false;
    return (await this.run(hasSessionCmd(name))).ok;
  }

  async listPanes(name: string): Promise<TmuxPane[]> {
    if (!isSafeSessionName(name)) return [];
    const res = await this.run(listPanesCmd(name));
    return res.ok ? parsePaneRows(res.stdout) : [];
  }

  async capturePane(paneId: string, lines: number): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    return this.run(capturePaneCmd(paneId, lines));
  }

  async selectPane(paneId: string): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    return this.run(selectPaneCmd(paneId));
  }

  async killPane(paneId: string): Promise<TmuxRunResult> {
    if (!isSafePaneId(paneId)) {
      return { ok: false, stdout: "", stderr: `unsafe pane id: ${paneId}` };
    }
    return this.run(killPaneCmd(paneId));
  }

  /** Only ever called with a name produced by `sessionNameFor`. */
  async killSession(name: string): Promise<TmuxRunResult> {
    if (!isSafeSessionName(name)) {
      return { ok: false, stdout: "", stderr: `unsafe session name: ${name}` };
    }
    return this.run(killSessionCmd(name));
  }
}
