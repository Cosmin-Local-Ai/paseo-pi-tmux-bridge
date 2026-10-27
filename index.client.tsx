import type { PluginClientContext } from "@getpaseo/plugin/client";
import { openAttachTerminalRpc } from "./shared/contracts.ts";
import { TmuxPanel } from "./client/panel.tsx";
import { BridgeSettingsScreen } from "./client/settings.tsx";

export default function contribute(client: PluginClientContext) {
  const panel = client.addAgentPanel({
    id: "pi-tmux-bridge",
    title: "tmux",
    icon: "Terminal",
    Component: TmuxPanel,
  });
  const settingsScreen = client.addSettingsScreen({
    id: "pi-tmux-bridge",
    title: "Pi tmux bridge",
    icon: "Terminal",
    Component: BridgeSettingsScreen,
  });
  const agentCommand = client.addCommandCenterItem({
    id: "pi-tmux-bridge.open",
    title: "Open attach terminal for this agent",
    icon: "Terminal",
    context: "agent",
    async onSelect({ agent, rpc }) {
      try {
        const result = await rpc(openAttachTerminalRpc, { agentId: agent.id });
        if (!result.ok) {
          console.error(`pi-tmux-bridge: ${result.detail ?? "no terminal opened"}`);
        }
      } catch (error) {
        console.error("pi-tmux-bridge:", error instanceof Error ? error.message : String(error));
      }
    },
  });
  const settingsCommand = client.addCommandCenterItem({
    id: "pi-tmux-bridge.settings",
    title: "Configure Pi tmux bridge",
    icon: "Settings",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("pi-tmux-bridge");
    },
  });

  return () => {
    panel();
    settingsScreen();
    agentCommand();
    settingsCommand();
  };
}
