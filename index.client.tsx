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

  const openPanelItem = client.addCommandCenterItem({
    id: "open-panel",
    title: "Open tmux panel for this agent",
    icon: "Terminal",
    keywords: ["tmux", "pane", "subagent", "bridge"],
    context: "agent",
    onSelect({ openPanel }) {
      // `explorer` docks the panel in the explorer pane, side by side with the
      // agent chat, instead of adding another workspace tab to click through.
      openPanel(AGENT_PANEL_ID, { location: "explorer" });
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
  const slashCommand = client.addSlashCommand({
    name: "tmux",
    description: "Open the tmux panel for this agent",
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
    openTerminalItem();
    settingsItem();
    slashCommand();
  };
}
