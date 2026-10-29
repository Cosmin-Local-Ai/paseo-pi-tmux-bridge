import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Settings shared by the server (`registerSettings`) and the client
 * (`useSettings`). Defaults are the values required by the design spec.
 *
 * `sessionPrefix` is deliberately restricted: it is concatenated with the
 * agent id to form a tmux session name that is later passed as a `-t` argv
 * element, so a leading `-` or shell/regex metacharacter must be impossible.
 */
/** One argv element of a namespace prefix; `{cwd}` / `{agentId}` are substituted. */
const execArgSchema = z.string().min(1).max(300);
const providerIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const bridgeSettings = defineSettings({
  id: "pi-tmux-bridge",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    sessionPrefix: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/, "Use letters, digits, dot, underscore or dash (max 32)")
      .default("paseo-"),
    layout: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/, "Lowercase tmux layout name")
      .default("even-horizontal"),
    placeholderCmd: z.string().trim().min(1).max(200).default("$SHELL -l"),
    /**
     * Absolute path to the tmux binary **inside the target namespace** (the
     * daemon host when `tmuxExec` / `providerTmuxExec` are empty, the container
     * otherwise). Empty means "find it yourself": `command -v tmux` inside the
     * namespace first, then a fixed candidate list. Authoritative when set.
     */
    tmuxPath: z
      .string()
      .trim()
      .regex(/^(?:|\/.{0,299})$/, "Use an absolute path such as /usr/bin/tmux")
      .default(""),
    /**
     * argv placed **before** the tmux binary for every tmux operation, so tmux
     * runs where the agent runs: `["sbx","exec","-i","-w","{cwd}","ctr","--"]`,
     * `["ssh","host"]`, `["nsenter","--mount=/run/x.mntns","--"]`. Empty (the
     * default) means run tmux on the daemon host, exactly as before.
     */
    tmuxExec: z.array(execArgSchema).max(16).default([]),
    /**
     * Per-provider prefix, keyed by the provider id Paseo reports (`pi`,
     * `pi-recovery`, …). Wins over `tmuxExec`; an explicit empty array means
     * "this provider uses the host".
     */
    providerTmuxExec: z.record(providerIdSchema, z.array(execArgSchema).max(16)).default({}),
    shellReadyDelayMs: z.number().int().min(0).max(60000).default(2000),
    autoAttachTerminal: z.boolean().default(true),
    /**
     * Paseo reports a custom provider's own id in `agent.session_open`, so a
     * provider declared as `extends: "pi"` (for example `pi-recovery`) is not
     * the string `pi`. Any id containing a `pi` token is treated as Pi by
     * default; list the exact ids here to be explicit or to override a name the
     * heuristic cannot see.
     */
    autoDetectPiProviders: z.boolean().default(true),
    piProviders: z
      .array(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
      .max(32)
      .default([]),
    /**
     * A Paseo agent is a top-level Pi session. Amos identity variables inherited
     * from the daemon make Amos treat the agent as an existing subagent and
     * refuse to spawn one.
     */
    stripAmosIdentity: z.boolean().default(true),
    killOnClose: z.boolean().default(true),
    paneCaptureLines: z.number().int().min(1).max(500).default(15),
    /**
     * How often the panel asks the server "did any pane produce output?". The
     * ask is one pane listing plus one `wc -c` of the pipe-log directory, so it
     * is cheap enough to run far faster than the old 2s screen poll; a capture
     * is only paid for panes whose pipe log actually grew.
     */
    /**
     * Tick interval for the panel's stream poll. Each tick costs one `list-panes`
     * plus one pipe-log listing, plus one capture per changed pane - all through the
     * namespace exec prefix - so the honest floor rises with the pane count. 1000ms
     * is what a three-subagent session sustains; drop it for a single pane.
     */
    livePollMs: z.number().int().min(200).max(10000).default(1000),
    /**
     * Close a subagent pane once tmux reports it dead. The panel's live tick
     * captures the pane's final transcript **first** and only then sends
     * `kill-pane`, so freeing the layout never costs the scrollback. The pane at
     * index 0 — the placeholder Amos splits every subagent from — is never a
     * candidate, and neither is any pane tmux does not report as dead.
     */
    reapDeadPanes: z.boolean().default(true),
    /**
     * How many finished-pane transcripts the daemon keeps per agent, newest last
     * (0 keeps none: the pane is still reaped, only the transcript is dropped).
     * They live in daemon memory only, and die with the daemon.
     */
    finishedPaneLimit: z.number().int().min(0).max(20).default(6),
    /**
     * Opt in to tmux keeping finished panes at all: the plugin sets
     * `remain-on-exit on` on its own session, which is what makes `pane_dead=1`
     * observable and lets the reap path free layout instead of the pane simply
     * vanishing. Off by default because it also keeps the session alive when the
     * placeholder shell exits, and a dead placeholder pane is exactly what breaks
     * Amos's split target. Finished panes are still captured (as `vanished`
     * transcripts) with this off.
     */
    keepFinishedPanes: z.boolean().default(false),
  }),
});

export type BridgeSettings = z.output<typeof bridgeSettings.schema>;

/**
 * Agent ids are Paseo-generated, but the client must never be able to steer a
 * tmux target, so every RPC takes an agentId and the server derives the
 * session name from it. A raw session/pane name is never accepted.
 */
const agentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Unexpected agent id");

const paneIdSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^%[0-9]{1,9}$/, "Expected a tmux pane id such as %12");

const paneDtoSchema = z.object({
  paneId: z.string(),
  paneIndex: z.string(),
  paneCurrentCommand: z.string(),
  panePid: z.string(),
  paneTitle: z.string(),
  paneWidth: z.string(),
  paneHeight: z.string(),
  active: z.boolean(),
  /**
   * tmux says this pane's process exited but the pane is still there. The panel
   * marks it in the header; the stream tick reaps it unless `reapDeadPanes` is
   * off. Defaults to false so an older server bundle still validates.
   */
  dead: z.boolean().default(false),
});

export type TmuxPaneDto = z.output<typeof paneDtoSchema>;

export const sessionStatusRpc = defineRpc({
  name: "session-status",
  input: z.object({ agentId: agentIdSchema }),
  output: z.object({
    agentId: z.string(),
    sessionName: z.string(),
    managed: z.boolean(),
    exists: z.boolean(),
    paneCount: z.number().int().min(0),
    terminalId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    cwd: z.string().nullable(),
    /** Whether the daemon host resolved a usable tmux at all. */
    tmuxAvailable: z.boolean(),
    /** Absolute path the plugin resolved; empty when nothing resolved. */
    tmuxPath: z.string(),
    /** Which namespace the tmux calls run in (`host`, `sbx:pi-recovery-test`). */
    tmuxExecLabel: z.string(),
    /** Every location probed, so a failure names what was tried. */
    tmuxTried: z.array(z.string()),
    detail: z.string().optional(),
  }),
});

export const listPanesRpc = defineRpc({
  name: "list-panes",
  input: z.object({ agentId: agentIdSchema }),
  output: z.object({
    agentId: z.string(),
    sessionName: z.string(),
    exists: z.boolean(),
    panes: z.array(paneDtoSchema),
    tmuxAvailable: z.boolean(),
    tmuxPath: z.string(),
    tmuxExecLabel: z.string(),
    tmuxTried: z.array(z.string()),
    detail: z.string().optional(),
  }),
});

export const capturePaneRpc = defineRpc({
  name: "capture-pane",
  input: z.object({
    agentId: agentIdSchema,
    paneId: paneIdSchema,
    lines: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    paneId: z.string(),
    text: z.string(),
    lines: z.number().int().min(0),
    detail: z.string().optional(),
  }),
});

/**
 * A pane the server reaped, with the transcript captured before the kill. This
 * is the "nothing is lost" half of the reap: after `kill-pane` tmux drops the
 * pane and its history, so the text has to be read out while the pane is still
 * there (see `FINISHED_CAPTURE_LINES` in server/tmux.ts). `text` went through
 * the same sanitizer as a live capture, so the panel renders it on the same
 * ANSI path. Kept in daemon memory only.
 */
const finishedPaneSchema = z.object({
  paneId: z.string(),
  title: z.string(),
  command: z.string(),
  width: z.string(),
  height: z.string(),
  text: z.string(),
  lines: z.number().int().min(0),
  /** epoch ms of the capture, which is also when the pane was killed. */
  at: z.number().int().min(0),
  /**
   * `reaped` = the plugin killed a pane tmux reported dead, after capturing it.
   * `killed` = a kill the panel asked for, also captured first.
   * `vanished` = tmux removed the pane itself (its default), so `text` is the
   * last live capture, **not** necessarily that pane's final output.
   */
  reason: z.enum(["reaped", "killed", "vanished"]),
});

export type FinishedPaneDto = z.output<typeof finishedPaneSchema>;

/**
 * Near-live pane content. The server arms `tmux pipe-pane` per pane and uses the
 * growth of those log files as a **change signal**, while the text itself still
 * comes from `capture-pane -p -e` (the pipe stream carries keystroke echo and
 * CRs, so it is not renderable). Unchanged panes come back with `changed:false`
 * and empty text so the client can skip repainting them.
 */
export const streamPanesRpc = defineRpc({
  name: "stream-panes",
  input: z.object({
    agentId: agentIdSchema,
    lines: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    agentId: z.string(),
    sessionName: z.string(),
    exists: z.boolean(),
    tmuxAvailable: z.boolean(),
    /**
     * A tick for this agent is already running, so this call returned nothing
     * useful. The client must skip it entirely - pruning captures on a busy tick
     * would blank the panel while a slow capture is still in flight.
     */
    busy: z.boolean().default(false),
    panes: z.array(
      z.object({
        paneId: z.string(),
        /** False = the pane's pipe log did not grow since the last call. */
        changed: z.boolean(),
        /** Screen text; empty unless `changed` is true. */
        text: z.string(),
        lines: z.number().int().min(0),
        /** Whether this pane's pipe is armed **and** its log is present. */
        piping: z.boolean(),
        /** tmux reports this pane's process as exited. */
        dead: z.boolean().default(false),
      }),
    ),
    /**
     * Finished panes this daemon has reaped, oldest first, newest last, capped at
     * `finishedPaneLimit`. A pane appears here only after its transcript was
     * captured, so the panel can show a killed pane's last screen.
     */
    finished: z.array(finishedPaneSchema).default([]),
    detail: z.string().optional(),
  }),
});

export type StreamPaneDto = z.output<typeof streamPanesRpc.output>["panes"][number];

export const selectPaneRpc = defineRpc({
  name: "select-pane",
  input: z.object({ agentId: agentIdSchema, paneId: paneIdSchema }),
  output: z.object({ ok: z.boolean(), paneId: z.string(), detail: z.string().optional() }),
});

export const killPaneRpc = defineRpc({
  name: "kill-pane",
  input: z.object({ agentId: agentIdSchema, paneId: paneIdSchema }),
  output: z.object({ ok: z.boolean(), paneId: z.string(), detail: z.string().optional() }),
});

/**
 * Named keys accepted by `send-keys`. Anything outside this list is rejected:
 * a bare string would be interpreted by tmux as a key name, so free text must
 * go through the `text` branch, which is sent with `-l` (literal).
 */
export const TMUX_KEY_NAMES = [
  "Enter",
  "C-c",
  "C-d",
  "C-l",
  "Escape",
  "Tab",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
] as const;

export type TmuxKeyName = (typeof TMUX_KEY_NAMES)[number];

/**
 * Type into a pane. This is what makes the panel more than a viewer: the text
 * branch is delivered with `send-keys -l`, so tmux cannot reinterpret shell
 * metacharacters as key names.
 */
export const sendKeysRpc = defineRpc({
  name: "send-keys",
  input: z.discriminatedUnion("mode", [
    z.object({
      agentId: agentIdSchema,
      paneId: paneIdSchema,
      mode: z.literal("text"),
      text: z.string().min(1).max(2000),
      enter: z.boolean().default(true),
    }),
    z.object({
      agentId: agentIdSchema,
      paneId: paneIdSchema,
      mode: z.literal("key"),
      key: z.enum(TMUX_KEY_NAMES),
    }),
  ]),
  output: z.object({ ok: z.boolean(), paneId: z.string(), detail: z.string().optional() }),
});

export const openAttachTerminalRpc = defineRpc({
  name: "open-attach-terminal",
  input: z.object({ agentId: agentIdSchema }),
  output: z.object({
    ok: z.boolean(),
    terminalId: z.string().nullable(),
    sessionName: z.string(),
    detail: z.string().optional(),
  }),
});
