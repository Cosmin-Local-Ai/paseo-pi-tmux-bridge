import type { PluginClientContext } from "@getpaseo/plugin/client";
import { openAttachTerminalRpc } from "./shared/contracts.ts";
import { TmuxPanel, TmuxWorkspacePanel } from "./client/panel.tsx";
import { BridgeSettingsScreen } from "./client/settings.tsx";

/**
 * Contribution ids are validated by the host against `/^[a-z][a-z0-9-]*$/`
 * (`packages/app/src/plugins/evaluate.ts`, `CONTRIBUTION_ID`). A dot throws
 * inside `contribute`, and the host then drops the **whole** client bundle with
 * `[Plugins] Failed to evaluate <plugin>` — panel, settings and commands all
 * gone. Keep every id below free of dots.
 */
const AGENT_PANEL_ID = "tmux";
const WORKSPACE_PANEL_ID = "tmux-workspace";
const SETTINGS_ID = "pi-tmux-bridge";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function contribute(client: PluginClientContext) {
  const panel = client.addAgentPanel({
    id: AGENT_PANEL_ID,
    title: "tmux",
    icon: "Terminal",
    locations: ["workspace", "explorer"],
    Component: TmuxPanel,
  });

  // Paseo's "+" new-tab menu lists only workspace-context panels, so the same
  // view is registered once more for the workspace, where it picks the agent.
  const workspacePanel = client.addWorkspacePanel({
    id: WORKSPACE_PANEL_ID,
    title: "tmux panes",
    icon: "Terminal",
    locations: ["workspace", "explorer"],
    Component: TmuxWorkspacePanel,
  });

  const settingsScreen = client.addSettingsScreen({
    id: SETTINGS_ID,
    title: "Pi tmux bridge",
    icon: "Terminal",
    Component: BridgeSettingsScreen,
  });

  // `workspace` opens the panel as a full-size workspace tab; `explorer` docks it
  // in the narrow explorer pane beside the chat. Paseo's default for a panel that
  // declares both is `workspace`, so that is what the primary entry points use.
  const openPanelItem = client.addCommandCenterItem({
    id: "open-panel",
    title: "Open tmux panes for this agent",
    icon: "Terminal",
    keywords: ["tmux", "pane", "subagent", "bridge"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(AGENT_PANEL_ID, { location: "workspace" });
    },
  });

  const openDockedPanelItem = client.addCommandCenterItem({
    id: "open-panel-docked",
    title: "Dock tmux panes beside this agent's chat",
    icon: "Terminal",
    keywords: ["tmux", "pane", "side", "docked", "explorer"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel(AGENT_PANEL_ID, { location: "explorer" });
    },
  });

  // Agent-context items are dropped unless BOTH a workspace and an agent are the
  // current context (`packages/app/src/plugins/command-center/contributions.ts`),
  // so the same view is offered at workspace level for when the command center is
  // opened from a workspace rather than an agent.
  const openWorkspacePanelItem = client.addCommandCenterItem({
    id: "open-workspace-panel",
    title: "Open tmux panes (any agent in this workspace)",
    icon: "Terminal",
    keywords: ["tmux", "pane", "subagent", "bridge", "workspace"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(WORKSPACE_PANEL_ID, { location: "workspace" });
    },
  });

  const openTerminalItem = client.addCommandCenterItem({
    id: "open-attach-terminal",
    title: "Open attach terminal for this agent",
    icon: "Terminal",
    keywords: ["tmux", "attach", "bridge"],
    context: "agent",
    async onSelect({ agent, rpc }) {
      try {
        const result = await rpc(openAttachTerminalRpc, { agentId: agent.id });
        if (!result.ok) {
          console.error(`pi-tmux-bridge: ${result.detail ?? "no terminal opened"}`);
        }
      } catch (error) {
        console.error("pi-tmux-bridge:", describeError(error));
      }
    },
  });

  const settingsItem = client.addCommandCenterItem({
    id: "configure",
    title: "Configure Pi tmux bridge",
    icon: "Settings",
    keywords: ["tmux", "bridge"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_ID);
    },
  });

  // The composer is where a user actually is, so `/tmux` is the shortest path
  // from "I cannot find the panel" to a rendered panel.
  // The composer is where a user actually is, and it needs no keyboard shortcut:
  // Ctrl+K is suppressed while a terminal has focus (`keyboard-shortcuts.ts`,
  // `when: { mac: false, terminal: false }`), which is exactly when panes are up.
  const slashCommand = client.addSlashCommand({
    name: "tmux",
    description: "Open this agent's tmux panes as a full-size tab",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(AGENT_PANEL_ID, { location: "workspace" });
    },
  });

  const slashCommandDocked = client.addSlashCommand({
    name: "tmux-side",
    description: "Dock this agent's tmux panes beside the chat",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel(AGENT_PANEL_ID, { location: "explorer" });
    },
  });

  return () => {
    panel();
    workspacePanel();
    settingsScreen();
    openPanelItem();
    openDockedPanelItem();
    openWorkspacePanelItem();
    openTerminalItem();
    settingsItem();
    slashCommand();
    slashCommandDocked();
  };
}
