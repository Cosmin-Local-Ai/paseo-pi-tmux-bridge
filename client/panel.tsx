import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  usePaseo,
  useRpc,
  useSettings,
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import {
  bridgeSettings,
  capturePaneRpc,
  killPaneRpc,
  listPanesRpc,
  openAttachTerminalRpc,
  selectPaneRpc,
  sendKeysRpc,
  streamPanesRpc,
  type FinishedPaneDto,
  type TmuxPaneDto,
} from "../shared/contracts.ts";
import {
  buildThemePalette,
  parseAnsi,
  resolveInverse,
  type AnsiLine,
  type AnsiPalette,
  type AnsiRun,
  type AnsiVariant,
} from "../shared/ansi.ts";

interface Snapshot {
  agentId: string;
  sessionName: string;
  exists: boolean;
  panes: TmuxPaneDto[];
  /** False when the agent's namespace has no usable tmux at all. */
  tmuxAvailable: boolean;
  tmuxPath: string;
  /** Where tmux runs: `host`, or a prefix label such as `sbx:pi-recovery-test`. */
  tmuxExecLabel: string;
  tmuxTried: string[];
  detail?: string;
}

/**
 * Structural poll: session inventory, pane list, tmux availability. Pane
 * *content* does not come from here — it comes from the faster `streamPanesRpc`
 * tick below, which is what makes the panel near-live instead of a 2s snapshot.
 */
const STRUCTURAL_POLL_INTERVAL_MS = 2000;
/** Used until the settings document is read; mirrors the schema default. */
const FALLBACK_LIVE_POLL_MS = 600;
const FALLBACK_CAPTURE_LINES = 15;
/** A full-size tab has the room; do not hold it to the explorer's 15 lines. */
const WIDE_CAPTURE_LINES = 48;

/** Timestamp of a finished-pane transcript; the pane itself is long gone by then. */
function finishedAt(at: number): string {
  const date = new Date(at);
  return Number.isFinite(at) ? date.toLocaleTimeString() : String(at);
}

/**
 * The server sends the whole finished FIFO on every tick, so the panel compares
 * it before storing: a new array identity each second would repaint up to
 * `finishedPaneLimit` × 200 captured lines on a poll whose whole design is "do
 * not re-read what did not change".
 */
function sameFinished(a: FinishedPaneDto[], b: FinishedPaneDto[]): boolean {
  return (
    a.length === b.length &&
    a.every((pane, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        other.paneId === pane.paneId &&
        other.at === pane.at &&
        other.lines === pane.lines &&
        other.reason === pane.reason
      );
    })
  );
}

interface FinishedStyle {
  item: Record<string, unknown>;
  title: Record<string, unknown>;
  muted: Record<string, unknown>;
  screen: Record<string, unknown>;
}

/**
 * What each reason actually means for the text below it. `vanished` is the one
 * that needs saying out loud: tmux removed the pane (its default behaviour), so
 * the transcript is the last screen the plugin had, not the pane's final output.
 */
const FINISHED_NOTE: Record<FinishedPaneDto["reason"], string> = {
  reaped: "captured before the plugin killed the pane",
  killed: "captured before the kill you asked for",
  vanished: "last live capture — tmux removed the pane, so this may not be its final output",
};

/** Memoised for the same reason as the identity check above. */
const FinishedPaneRow = memo(function FinishedPaneRow({
  pane,
  palette,
  base,
  styles,
}: {
  pane: FinishedPaneDto;
  palette: AnsiPalette;
  base: Record<string, unknown>;
  styles: FinishedStyle;
}) {
  return (
    <View style={styles.item}>
      <Text style={styles.title}>
        {`${pane.paneId} · ${pane.command || "?"} · ${pane.title || "(no title)"} · ${pane.width}x${pane.height} · ${finishedAt(pane.at)}`}
      </Text>
      <Text style={styles.muted}>
        {`${pane.reason} · ${pane.lines} line${pane.lines === 1 ? "" : "s"} · ${FINISHED_NOTE[pane.reason]}`}
      </Text>
      {pane.text ? (
        <AnsiScreen lines={parseAnsi(pane.text, palette)} palette={palette} base={base} />
      ) : (
        <Text style={styles.screen}>{"(no captured output)"}</Text>
      )}
    </View>
  );
});

/**
 * `PluginTheme` carries no colorScheme, so the palette variant is inferred from
 * the surface/foreground pair: a darker surface means a dark theme.
 */
function luminance(color: string): number | null {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function variantForTheme(theme: PluginAgentPanelProps["theme"]): AnsiVariant {
  const surface = luminance(theme.colors.surface0);
  const foreground = luminance(theme.colors.foreground);
  if (surface === null || foreground === null) return "dark";
  return surface <= foreground ? "dark" : "light";
}

function runStyle(run: AnsiRun, base: Record<string, unknown>): Record<string, unknown> {
  const style: Record<string, unknown> = { ...base };
  if (run.fg) style.color = run.fg;
  if (run.bg) style.backgroundColor = run.bg;
  if (run.bold) style.fontWeight = "bold";
  if (run.italic) style.fontStyle = "italic";
  if (run.dim) style.opacity = 0.62;
  if (run.underline && run.strike) style.textDecorationLine = "underline line-through";
  else if (run.underline) style.textDecorationLine = "underline";
  else if (run.strike) style.textDecorationLine = "line-through";
  return style;
}

/**
 * One pane's screen, rendered with the same ANSI palette Paseo's own terminal
 * uses. Each line is one Text so line boxes stay aligned; runs nest inside it.
 */
function AnsiScreen({
  lines,
  palette,
  base,
}: {
  lines: AnsiLine[];
  palette: AnsiPalette;
  base: Record<string, unknown>;
}) {
  return (
    <View style={{ backgroundColor: palette.defaultBg, padding: 8, borderRadius: 6 }}>
      {lines.map((line, index) => (
        <Text key={`line-${index}`} style={base}>
          {line.runs.length === 0
            ? " "
            : line.runs
                .filter((run) => run.text.length > 0)
                .map((run, runIndex) => {
                  const resolved = run.inverse ? resolveInverse(run, palette) : run;
                  return (
                    <Text key={`run-${index}-${runIndex}`} style={runStyle(resolved, base)}>
                      {run.text}
                    </Text>
                  );
                })}
        </Text>
      ))}
    </View>
  );
}

/**
 * View of the current agent's tmux session: pane inventory plus the last screen
 * lines of each pane, with focus/kill/attach actions.
 *
 * Two clocks. Pane content streams on `livePollMs` through `streamPanesRpc`,
 * which only returns text for panes whose `pipe-pane` log grew, so the panel is
 * near-live without paying a `capture-pane` for every pane on every tick. The
 * inventory (panes, session, tmux availability) refreshes on the slower 2s
 * structural clock, and the Refresh button forces a full capture of everything.
 * A missing session renders as a plain message rather than an error.
 */
export function TmuxPanel({ theme, layout, params }: PluginAgentPanelProps) {
  return <TmuxPanelBody theme={theme} layout={layout} agentId={params.agentId} />;
}

function TmuxPanelBody({
  theme,
  layout,
  agentId,
}: {
  theme: PluginAgentPanelProps["theme"];
  layout: PluginAgentPanelProps["layout"];
  agentId: string;
}) {
  const callListPanes = useRpc(listPanesRpc);
  const callCapturePane = useRpc(capturePaneRpc);
  const callStreamPanes = useRpc(streamPanesRpc);
  const callSelectPane = useRpc(selectPaneRpc);
  const callKillPane = useRpc(killPaneRpc);
  const callOpenTerminal = useRpc(openAttachTerminalRpc);
  const callSendKeys = useRpc(sendKeysRpc);
  const settings = useSettings(bridgeSettings);
  const toast = useToast();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [captures, setCaptures] = useState<Record<string, string>>({});
  /**
   * Panes the server already reaped, with the transcript it captured before the
   * kill. The server owns this list (it is bounded by `finishedPaneLimit` and
   * lives only in daemon memory), so every tick just replaces it wholesale.
   */
  const [finished, setFinished] = useState<FinishedPaneDto[]>([]);
  /** Collapsed by default: finished panes must not crowd the live ones. */
  const [showFinished, setShowFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailPane, setDetailPane] = useState<{ paneId: string; text: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const inFlight = useRef(false);
  const structuralInFlight = useRef(false);
  const streamInFlight = useRef(false);
  /** False while the panel sits in a hidden tab, so the stream idles. */
  const visible = useRef(true);
  /**
   * The content tick that is running, or null when nothing streams — hidden
   * panel, no session, no tmux, or a stream call that failed. This is what the
   * header's `live` / `paused` indicator reads.
   */
  const [liveMs, setLiveMs] = useState<number | null>(null);

  const settingLines =
    settings.status === "ready" ? settings.values.paneCaptureLines : FALLBACK_CAPTURE_LINES;
  const livePollMs = settings.status === "ready" ? settings.values.livePollMs : FALLBACK_LIVE_POLL_MS;
  // The explorer pane is narrow and short; a workspace tab is not. Ask tmux for
  // more history only when there is room to show it.
  const captureLines = layout.compact ? settingLines : Math.max(settingLines, WIDE_CAPTURE_LINES);

  const palette = useMemo(
    () => buildThemePalette(theme, variantForTheme(theme)),
    [theme],
  );
  const ansiBase = useMemo(
    () => ({
      color: palette.defaultFg,
      fontFamily: "monospace",
      fontSize: layout.compact ? 11 : 12.5,
      lineHeight: layout.compact ? 14 : 17,
    }),
    [layout.compact, palette.defaultFg],
  );

  /**
   * Inventory only: which panes exist, whether the session and tmux are there.
   * Screens are left to the stream so a slow capture never delays the poll.
   */
  const refreshStructure = useCallback(async () => {
    if (structuralInFlight.current) return;
    structuralInFlight.current = true;
    try {
      const result = await callListPanes({ agentId });
      setSnapshot(result);
      setError(null);
      if (!result.exists) {
        setCaptures({});
        setFinished([]);
        return;
      }
      // A pane that is gone must not keep painting a stale screen.
      const live = new Set(result.panes.map((pane) => pane.paneId));
      setCaptures((current) => {
        const kept = Object.fromEntries(
          Object.entries(current).filter(([paneId]) => live.has(paneId)),
        );
        return Object.keys(kept).length === Object.keys(current).length ? current : kept;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      structuralInFlight.current = false;
    }
  }, [agentId, callListPanes]);

  /**
   * Fast content tick. The server reports only the panes whose pipe log grew, so
   * an unchanged pane costs one small object on the wire and no repaint here.
   */
  const streamContent = useCallback(async () => {
    if (streamInFlight.current || !visible.current) return;
    streamInFlight.current = true;
    try {
      const result = await callStreamPanes({ agentId, lines: captureLines });
      if (result.busy) {
        // Another view (agent panel plus workspace panel, or a second window) owns
        // the tick for this agent. Skip without touching captures: an empty pane
        // list on a busy tick must not blank the panel.
        setLiveMs(null);
        return;
      }
      setLiveMs(livePollMs);
      setCaptures((current) => {
        let next = current;
        for (const pane of result.panes) {
          if (!pane.changed) continue;
          if (next === current) next = { ...current };
          next[pane.paneId] = pane.text;
        }
        return next;
      });
      // The server's list is the whole truth, newest last: a reaped pane leaves
      // `panes` and appears here with the screen it had when it died. Keep the
      // old identity while the content matches so the section does not repaint.
      setFinished((current) => (sameFinished(current, result.finished) ? current : result.finished));
    } catch {
      // A dropped tick must not blank the panel: keep the last screens and say
      // `paused` until the stream comes back.
      setLiveMs(null);
    } finally {
      streamInFlight.current = false;
    }
  }, [agentId, callStreamPanes, captureLines, livePollMs]);

  /** Full snapshot: inventory plus a forced capture of every pane. */
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await callListPanes({ agentId });
      setSnapshot(result);
      setError(null);
      if (!result.exists) {
        setCaptures({});
        return;
      }
      const entries = await Promise.all(
        result.panes.map(async (pane) => {
          try {
            const captured = await callCapturePane({ agentId, paneId: pane.paneId, lines: captureLines });
            // Colour comes from tmux `-e`; junk was already stripped server-side.
            return [pane.paneId, captured.detail ? `${captured.detail}` : captured.text] as const;
          } catch {
            return [pane.paneId, ""] as const;
          }
        }),
      );
      setCaptures(Object.fromEntries(entries));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlight.current = false;
    }
  }, [agentId, callCapturePane, callListPanes, captureLines]);

  useEffect(() => {
    void refreshStructure();
    const timer = setInterval(() => void refreshStructure(), STRUCTURAL_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshStructure]);

  /**
   * Content polls on their own, faster clock. Streaming stops when the panel
   * already knows there is nothing to poll (no tmux, no session) — that is the
   * `paused` case the header shows — and restarts as soon as either returns.
   * The deps are the two booleans rather than the snapshot object so the 2s
   * structural refresh does not tear this interval down every time.
   */
  useEffect(() => {
    if (snapshot !== null && (!snapshot.tmuxAvailable || !snapshot.exists)) {
      setLiveMs(null);
      return;
    }
    void streamContent();
    const timer = setInterval(() => void streamContent(), livePollMs);
    return () => {
      clearInterval(timer);
      setLiveMs(null);
    };
  }, [livePollMs, snapshot?.exists, snapshot?.tmuxAvailable, streamContent]);

  // A panel in a background tab or a hidden window should not pay for a poll.
  // Guarded because the panel runs wherever the host renders it.
  useEffect(() => {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    const onVisibility = () => {
      visible.current = document.visibilityState !== "hidden";
      if (!visible.current) setLiveMs(null);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const runAction = useCallback(
    async (key: string, action: () => Promise<void>, done: string) => {
      setBusy(key);
      try {
        await action();
        toast.show(done);
        void refresh();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
      }
    },
    [refresh, toast],
  );

  const handleFocus = useCallback(
    (paneId: string) =>
      runAction(`focus:${paneId}`, async () => {
        const result = await callSelectPane({ agentId, paneId });
        if (!result.ok) throw new Error(result.detail ?? "select-pane failed");
      }, `Focused ${paneId}`),
    [agentId, callSelectPane, runAction],
  );

  const handleKill = useCallback(
    (paneId: string) =>
      runAction(`kill:${paneId}`, async () => {
        const result = await callKillPane({ agentId, paneId });
        if (!result.ok) throw new Error(result.detail ?? "kill-pane failed");
      }, `Killed ${paneId}`),
    [agentId, callKillPane, runAction],
  );

  const handleOpenTerminal = useCallback(
    () =>
      runAction("open-terminal", async () => {
        const result = await callOpenTerminal({ agentId });
        if (!result.ok) throw new Error(result.detail ?? "could not open a terminal");
      }, "Attach terminal opened"),
    [agentId, callOpenTerminal, runAction],
  );

  const handleSendText = useCallback(
    (paneId: string) => {
      const text = (draft[paneId] ?? "").trim();
      if (text.length === 0) return;
      return runAction(`send:${paneId}`, async () => {
        const result = await callSendKeys({ agentId, paneId, mode: "text", text, enter: true });
        if (!result.ok) throw new Error(result.detail ?? "send-keys failed");
        setDraft((current) => ({ ...current, [paneId]: "" }));
      }, `Sent to ${paneId}`);
    },
    [agentId, callSendKeys, draft, runAction],
  );

  const handleSendKey = useCallback(
    (paneId: string, key: "C-c" | "Escape") =>
      runAction(`key:${paneId}:${key}`, async () => {
        const result = await callSendKeys({ agentId, paneId, mode: "key", key });
        if (!result.ok) throw new Error(result.detail ?? `send-keys ${key} failed`);
      }, `${key} sent to ${paneId}`),
    [agentId, callSendKeys, runAction],
  );

  const handleInspect = useCallback(
    async (paneId: string) => {
      try {
        const captured = await callCapturePane({ agentId, paneId, lines: 200 });
        setDetailPane({ paneId, text: captured.detail ?? captured.text });
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [agentId, callCapturePane, toast],
  );

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 12 : 20,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 16 : 18 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 6,
      },
      paneTitle: { color: theme.colors.foreground, fontSize: 13 },
      screen_: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontFamily: "monospace",
      },
      input: {
        flex: 1,
        minWidth: 140,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontSize: 12,
        fontFamily: "monospace",
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      // Panes sit side by side, left to right in tmux index order, so a
      // subagent that tmux splits to the right also appears on the right here.
      panesRow: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 12,
        alignItems: "stretch" as const,
      },
      paneCard: {
        flex: 1,
        minWidth: 280,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 6,
      },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      live: { color: theme.colors.statusSuccess, fontSize: 12 },
      primary: { backgroundColor: theme.colors.accent },
      primaryText: { color: theme.colors.accentForeground, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      // The finished section sits outside the pane row on purpose: a finished
      // pane has no actions, and mixing it in would read like a live pane.
      finishedHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
    }),
    [layout.compact, theme],
  );

  /** Passed as one stable object so `FinishedPaneRow` can stay memoised. */
  const finishedStyles = useMemo(
    () => ({
      item: {
        borderTopColor: theme.colors.border,
        borderTopWidth: 1,
        paddingTop: 8,
        gap: 4,
      },
      title: { color: theme.colors.foreground, fontSize: 13 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      screen: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" },
    }),
    [theme],
  );

  const panes = snapshot?.panes ?? [];
  const sessionName = snapshot?.sessionName ?? "";
  // The daemon could not resolve tmux anywhere. Saying so beats an empty panel.
  const tmuxMissing = snapshot !== null && snapshot.tmuxAvailable === false;
  const missingText =
    snapshot?.detail ?? "tmux not found in the agent's namespace — install tmux there or set tmuxPath";

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Icon
          name="Terminal"
          size={18}
          color={tmuxMissing ? theme.colors.statusDanger : theme.colors.foreground}
        />
        <Text style={styles.title}>
          {tmuxMissing
            ? `tmux not found${
                snapshot?.tmuxExecLabel && snapshot.tmuxExecLabel !== "host"
                  ? ` in ${snapshot.tmuxExecLabel}`
                  : " on daemon host"
              }`
            : snapshot
              ? `tmux · ${sessionName || "no session"}`
              : "tmux · loading…"}
        </Text>
        <Text style={tmuxMissing ? styles.danger : styles.muted}>
          {tmuxMissing
            ? "install tmux there or set tmuxPath / tmuxExec"
            : `${panes.length} pane${panes.length === 1 ? "" : "s"}` +
              (snapshot?.tmuxExecLabel ? ` · ${snapshot.tmuxExecLabel}` : "") +
              (snapshot?.tmuxPath ? ` · ${snapshot.tmuxPath}` : "")}
        </Text>
        <Text style={liveMs === null ? styles.muted : styles.live}>
          {liveMs === null ? "paused" : `live · ${liveMs}ms`}
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            onPress={handleOpenTerminal}
            style={[styles.button, styles.primary]}
            disabled={busy === "open-terminal" || tmuxMissing}
          >
            <Text style={styles.primaryText}>
              {tmuxMissing
                ? "tmux unavailable"
                : busy === "open-terminal"
                  ? "Opening…"
                  : "Open attach terminal"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void refresh()}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Refresh</Text>
          </Pressable>
        </View>
        {error ? <Text style={styles.danger}>{error}</Text> : null}
        {tmuxMissing ? (
          <Text style={styles.danger}>
            {missingText}
            {snapshot && snapshot.tmuxExecLabel !== "host"
              ? `\nNamespace: ${snapshot.tmuxExecLabel}`
              : ""}
            {snapshot && snapshot.tmuxTried.length > 0
              ? `\nTried: ${snapshot.tmuxTried.join(", ")}`
              : ""}
          </Text>
        ) : null}
        {snapshot && !snapshot.exists && !tmuxMissing ? (
          <Text style={styles.warning}>
            {snapshot.detail ??
              `No tmux session for this agent yet. It is created when a Pi session opens.`}
          </Text>
        ) : null}
      </View>

      <View style={styles.panesRow}>
      {panes.map((pane) => (
        <View key={pane.paneId} style={styles.paneCard}>
          <Pressable
            accessibilityRole="button"
            onPress={() => void handleInspect(pane.paneId)}
            style={styles.row}
          >
            <Icon
              name={pane.active ? "CircleDot" : "Circle"}
              size={14}
              color={pane.active ? theme.colors.accent : theme.colors.foregroundMuted}
            />
            {/* tmux says the process exited but the pane is still there; the
                stream tick reaps it unless `reapDeadPanes` is off, so say so here
                rather than letting it look like a live pane. */}
            <Text style={pane.dead ? styles.warning : styles.paneTitle}>
              {`${pane.paneId} · ${pane.paneCurrentCommand || "?"} · ${pane.paneWidth}x${pane.paneHeight}` +
                (pane.dead ? " · dead" : "")}
            </Text>
          </Pressable>
          <Text style={styles.paneTitle}>
            {`index ${pane.paneIndex} · pid ${pane.panePid} · title ${pane.paneTitle || "(none)"}`}
          </Text>
          {captures[pane.paneId] ? (
            <AnsiScreen
              lines={parseAnsi(captures[pane.paneId], palette)}
              palette={palette}
              base={ansiBase}
            />
          ) : (
            <Text style={styles.screen_}>{"(no captured output)"}</Text>
          )}
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              value={draft[pane.paneId] ?? ""}
              onChangeText={(text) => setDraft((current) => ({ ...current, [pane.paneId]: text }))}
              onSubmitEditing={() => void handleSendText(pane.paneId)}
              returnKeyType="send"
              submitBehavior="submit"
              placeholder={`type into ${pane.paneId}…`}
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline={false}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleSendText(pane.paneId)}
              style={[styles.button, styles.primary]}
              disabled={busy === `send:${pane.paneId}` || (draft[pane.paneId] ?? "").trim() === ""}
            >
              <Text style={styles.primaryText}>Send</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => handleSendKey(pane.paneId, "C-c")}
              style={styles.button}
              disabled={busy === `key:${pane.paneId}:C-c`}
            >
              <Text style={styles.danger}>Ctrl-C</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() => handleFocus(pane.paneId)}
              style={styles.button}
              disabled={busy === `focus:${pane.paneId}`}
            >
              <Text style={styles.buttonText}>Focus</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => handleKill(pane.paneId)}
              style={styles.button}
              disabled={busy === `kill:${pane.paneId}`}
            >
              <Text style={styles.danger}>Kill pane</Text>
            </Pressable>
          </View>
        </View>
      ))}
      </View>

      {panes.length === 0 && snapshot?.exists ? (
        <View style={styles.card}>
          <Text style={styles.muted}>{"This session has no panes."}</Text>
        </View>
      ) : null}

      {finished.length > 0 ? (
        <View style={styles.card}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowFinished((current) => !current)}
            style={styles.finishedHead}
          >
            <Icon
              name={showFinished ? "ChevronDown" : "ChevronRight"}
              size={14}
              color={theme.colors.foregroundMuted}
            />
            <Text style={styles.paneTitle}>{`finished (${finished.length})`}</Text>
            <Text style={styles.muted}>
              {"pane closed by the plugin after its last screen was captured"}
            </Text>
          </Pressable>
          {showFinished
            ? finished.map((pane) => (
                <FinishedPaneRow
                  key={pane.paneId}
                  pane={pane}
                  palette={palette}
                  base={ansiBase}
                  styles={finishedStyles}
                />
              ))
            : null}
        </View>
      ) : null}

      <Modal
        title={`Pane ${detailPane?.paneId ?? ""}`}
        open={detailPane !== null}
        onOpenChange={(open) => {
          if (!open) setDetailPane(null);
        }}
      >
        <Modal.Content>
          {detailPane?.text
            ? <AnsiScreen lines={parseAnsi(detailPane.text, palette)} palette={palette} base={ansiBase} />
            : <Text style={styles.screen_}>{""}</Text>}
        </Modal.Content>
      </Modal>
    </View>
  );
}

interface WorkspaceAgentOption {
  id: string;
  provider: string;
  status: string;
}

const AGENT_LIST_INTERVAL_MS = 5000;

/**
 * Workspace-scoped copy of the same view. Paseo's "+" new-tab menu lists only
 * workspace-context panels, so this is the entry point that is always
 * reachable from the tab strip; it resolves the agent from the workspace.
 */
export function TmuxWorkspacePanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<WorkspaceAgentOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await paseo.agents.list({ page: { limit: 100 } });
        if (cancelled) return;
        const options: WorkspaceAgentOption[] = [];
        for (const entry of result.entries) {
          const agent = entry.agent;
          if (!agent || agent.workspaceId !== workspaceId) continue;
          options.push({
            id: agent.id,
            provider: String(agent.provider ?? "?"),
            status: String(agent.status ?? "?"),
          });
        }
        setAgents(options);
        setSelected((current) =>
          current && options.some((option) => option.id === current)
            ? current
            : (options[0]?.id ?? null),
        );
        setLoadError(null);
      } catch (caught) {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const timer = setInterval(() => void load(), AGENT_LIST_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paseo, workspaceId]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 12 : 20,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 6,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    }),
    [layout.compact, theme],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        {loadError ? <Text style={styles.danger}>{loadError}</Text> : null}
        {agents.length === 0 && !loadError ? (
          <Text style={styles.muted}>{"No agents in this workspace."}</Text>
        ) : null}
        {agents.map((agent) => (
          <Pressable
            key={agent.id}
            accessibilityRole="button"
            onPress={() => setSelected(agent.id)}
            style={styles.row}
          >
            <Icon
              name={agent.id === selected ? "CircleDot" : "Circle"}
              size={14}
              color={agent.id === selected ? theme.colors.accent : theme.colors.foregroundMuted}
            />
            <Text style={styles.muted}>
              {`${agent.provider} · ${agent.status} · ${agent.id.slice(0, 8)}`}
            </Text>
          </Pressable>
        ))}
      </View>
      {selected ? (
        <TmuxPanelBody theme={theme} layout={layout} agentId={selected} />
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>
            {"Pick an agent, or use /tmux in the composer for this agent's panes."}
          </Text>
        </View>
      )}
    </View>
  );
}
