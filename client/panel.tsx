import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  usePaseo,
  useRpc,
  useSettings,
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/ui";
import {
  bridgeSettings,
  capturePaneRpc,
  killPaneRpc,
  listPanesRpc,
  openAttachTerminalRpc,
  selectPaneRpc,
  type TmuxPaneDto,
} from "../shared/contracts.ts";

interface Snapshot {
  agentId: string;
  sessionName: string;
  exists: boolean;
  panes: TmuxPaneDto[];
  detail?: string;
}

const POLL_INTERVAL_MS = 2000;
const FALLBACK_CAPTURE_LINES = 15;

/**
 * Read-only view of the current agent's tmux session: pane inventory plus the
 * last screen lines of each pane, with focus/kill/attach actions. Polling is
 * paused while the panel is unmounted, and a missing session renders as a
 * plain message rather than an error.
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
  const callSelectPane = useRpc(selectPaneRpc);
  const callKillPane = useRpc(killPaneRpc);
  const callOpenTerminal = useRpc(openAttachTerminalRpc);
  const settings = useSettings(bridgeSettings);
  const toast = useToast();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [captures, setCaptures] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailPane, setDetailPane] = useState<{ paneId: string; text: string } | null>(null);
  const inFlight = useRef(false);

  const captureLines =
    settings.status === "ready" ? settings.values.paneCaptureLines : FALLBACK_CAPTURE_LINES;

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
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

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
      primary: { backgroundColor: theme.colors.accent },
      primaryText: { color: theme.colors.accentForeground, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
    }),
    [layout.compact, theme],
  );

  const panes = snapshot?.panes ?? [];
  const sessionName = snapshot?.sessionName ?? "";

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Icon name="Terminal" size={18} color={theme.colors.foreground} />
        <Text style={styles.title}>
          {snapshot ? `tmux · ${sessionName || "no session"}` : "tmux · loading…"}
        </Text>
        <Text style={styles.muted}>{`${panes.length} pane${panes.length === 1 ? "" : "s"}`}</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            onPress={handleOpenTerminal}
            style={[styles.button, styles.primary]}
            disabled={busy === "open-terminal"}
          >
            <Text style={styles.primaryText}>
              {busy === "open-terminal" ? "Opening…" : "Open attach terminal"}
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
        {snapshot && !snapshot.exists ? (
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
            <Text style={styles.paneTitle}>
              {`${pane.paneId} · ${pane.paneCurrentCommand || "?"} · ${pane.paneWidth}x${pane.paneHeight}`}
            </Text>
          </Pressable>
          <Text style={styles.paneTitle}>
            {`index ${pane.paneIndex} · pid ${pane.panePid} · title ${pane.paneTitle || "(none)"}`}
          </Text>
          <Text style={styles.screen_} numberOfLines={captureLines}>
            {captures[pane.paneId] || "(no captured output)"}
          </Text>
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

      <Modal
        title={`Pane ${detailPane?.paneId ?? ""}`}
        open={detailPane !== null}
        onOpenChange={(open) => {
          if (!open) setDetailPane(null);
        }}
      >
        <Modal.Content>
          <Text style={styles.screen_}>{detailPane?.text ?? ""}</Text>
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
