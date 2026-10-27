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
    shellReadyDelayMs: z.number().int().min(0).max(60000).default(2000),
    autoAttachTerminal: z.boolean().default(true),
    killOnClose: z.boolean().default(true),
    paneCaptureLines: z.number().int().min(1).max(500).default(15),
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
