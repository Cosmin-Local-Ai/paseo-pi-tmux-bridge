import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { bridgeSettings } from "../shared/contracts.ts";

type Ready = Extract<SettingsState<typeof bridgeSettings.schema>, { status: "ready" }>;

/**
 * Numeric settings are held in a draft and committed by an explicit action:
 * `SettingsInput` has no blur callback, and saving on every keystroke would
 * fail schema validation mid-typing.
 */
function NumberField({
  label,
  hint,
  value,
  settings,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  settings: Ready;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const commit = useCallback(() => {
    const parsed = Number.parseInt(shown, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      setDraft(null);
      return;
    }
    setDraft(null);
    onCommit(parsed);
  }, [onCommit, shown]);
  return (
    <>
      <SettingsInput
        label={label}
        hint={hint}
        initialValue={shown}
        onChangeText={setDraft}
        disabled={settings.saving}
        error={settings.saveError}
      />
      <SettingsAction
        label={label}
        actionLabel="Save number"
        disabled={settings.saving || draft === null}
        onPress={commit}
      />
    </>
  );
}

/**
 * JSON-shaped setting (argv prefix, provider map). Held in a draft and saved
 * explicitly: half-typed JSON would be rejected by the schema on every key.
 */
function JsonField({
  label,
  hint,
  value,
  settings,
  kind,
  onCommit,
}: {
  label: string;
  hint: string;
  value: unknown;
  settings: Ready;
  kind: "array" | "object";
  onCommit(value: unknown): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const shown = draft ?? JSON.stringify(value);
  const commit = useCallback(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(shown);
    } catch {
      setParseError(`Not valid JSON. Example: ${kind === "array" ? '["sbx","exec","ctr","--"]' : '{"pi-recovery":["sbx","exec","ctr","--"]}'}`);
      return;
    }
    const ok = kind === "array" ? Array.isArray(parsed) : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    if (!ok) {
      setParseError(`Expected a JSON ${kind}.`);
      return;
    }
    setParseError(null);
    onCommit(parsed);
  }, [kind, onCommit, shown]);
  return (
    <>
      <SettingsInput
        label={label}
        hint={hint}
        initialValue={shown}
        onChangeText={setDraft}
        disabled={settings.saving}
        error={parseError ?? settings.saveError}
      />
      <SettingsAction
        label={label}
        actionLabel="Save JSON"
        disabled={settings.saving || draft === null}
        onPress={commit}
      />
    </>
  );
}

function Controls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const values = settings.values;
  const patch = useCallback(
    (next: Partial<Ready["values"]>) => {
      void settings.save({ ...settings.values, ...next }, settings.revision);
    },
    [settings],
  );

  return (
    <SettingsSection title="Pi tmux bridge">
      <SettingsCard>
        <SettingsSwitch
          label="Enabled"
          hint="Give every Pi agent its own tmux session."
          value={values.enabled}
          disabled={settings.saving}
          onValueChange={(enabled) => patch({ enabled })}
        />
        <SettingsSwitch
          label="Auto-open attach terminal"
          hint="Open `tmux attach -t <session>` in the agent workspace when a session opens."
          value={values.autoAttachTerminal}
          disabled={settings.saving}
          onValueChange={(autoAttachTerminal) => patch({ autoAttachTerminal })}
        />
        <SettingsSwitch
          label="Kill session on close/archive"
          hint="Only sessions named <prefix><agentId> are ever killed."
          value={values.killOnClose}
          disabled={settings.saving}
          onValueChange={(killOnClose) => patch({ killOnClose })}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          label="Session prefix"
          hint="Letters, digits, dot, underscore, dash. Session = prefix + agent id."
          initialValue={values.sessionPrefix}
          onChangeText={(sessionPrefix) => patch({ sessionPrefix })}
          disabled={settings.saving}
          error={settings.saveError}
        />
        <SettingsInput
          label="Layout"
          hint="tmux select-layout name, e.g. even-horizontal or main-vertical."
          initialValue={values.layout}
          onChangeText={(layout) => patch({ layout })}
          disabled={settings.saving}
          error={settings.saveError}
        />
        <SettingsInput
          label="Placeholder command"
          hint="Keeps the host pane alive. $SHELL is substituted."
          initialValue={values.placeholderCmd}
          onChangeText={(placeholderCmd) => patch({ placeholderCmd })}
          disabled={settings.saving}
          error={settings.saveError}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsInput
          label="tmux path"
          hint="Absolute path to tmux inside the namespace it runs in. Empty = probe. Set = authoritative."
          initialValue={values.tmuxPath}
          onChangeText={(tmuxPath) => patch({ tmuxPath })}
          disabled={settings.saving}
          error={settings.saveError}
        />
        <JsonField
          label="tmux exec prefix"
          hint={
            'argv before tmux for every call, e.g. ["sbx","exec","-i","-w","{cwd}","ctr","--"]. Placeholders: {cwd}, {agentId}. Empty = daemon host.'
          }
          value={values.tmuxExec}
          kind="array"
          settings={settings}
          onCommit={(tmuxExec) => patch({ tmuxExec: tmuxExec as Ready["values"]["tmuxExec"] })}
        />
        <JsonField
          label="provider exec prefixes"
          hint='Per-provider map, wins over the global prefix: {"pi-recovery":["sbx","exec","ctr","--"]}. An explicit [] pins that provider to the host.'
          value={values.providerTmuxExec}
          kind="object"
          settings={settings}
          onCommit={(providerTmuxExec) =>
            patch({ providerTmuxExec: providerTmuxExec as Ready["values"]["providerTmuxExec"] })
          }
        />
        <JsonField
          label="extra Pi provider ids"
          hint='Providers to treat as Pi even when the name heuristic cannot see them: ["my-pi-wrapper"].'
          value={values.piProviders}
          kind="array"
          settings={settings}
          onCommit={(piProviders) => patch({ piProviders: piProviders as Ready["values"]["piProviders"] })}
        />
      </SettingsCard>
      <SettingsCard>
        <NumberField
          label="Shell ready delay (ms)"
          hint="Written to PI_SUBAGENT_SHELL_READY_DELAY_MS; Amos defaults to 500."
          value={values.shellReadyDelayMs}
          settings={settings}
          onCommit={(shellReadyDelayMs) => patch({ shellReadyDelayMs })}
        />
        <NumberField
          label="Pane capture lines"
          hint="How much of each pane the plugin panel shows."
          value={values.paneCaptureLines}
          settings={settings}
          onCommit={(paneCaptureLines) => patch({ paneCaptureLines })}
        />
      </SettingsCard>
      <SettingsRow label="Current values">
        <View>
          <Text style={style}>
            {values.enabled ? "enabled" : "disabled"} · prefix {values.sessionPrefix} · layout{" "}
            {values.layout}
          </Text>
          <Text style={style}>
            placeholder {values.placeholderCmd} · delay {values.shellReadyDelayMs}ms · capture{" "}
            {values.paneCaptureLines} lines
          </Text>
          <Text style={style}>
            tmux {values.tmuxPath || "(probed)"} · exec {JSON.stringify(values.tmuxExec)} · per
            provider {JSON.stringify(values.providerTmuxExec)}
          </Text>
        </View>
      </SettingsRow>
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={style}>
          {settings.saveError}
        </Text>
      ) : null}
      <SettingsAction
        label="Restore defaults"
        actionLabel="Reset"
        disabled={settings.saving}
        onPress={settings.reset}
      />
    </SettingsSection>
  );
}

export function BridgeSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(bridgeSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Pi tmux bridge">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }
  return <Controls settings={settings} theme={theme} />;
}
