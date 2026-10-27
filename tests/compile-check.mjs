/**
 * Phase B verification: compile this plugin with Paseo's own plugin compiler
 * (`packages/server/src/server/plugins/compiler.ts`), which enforces the SDK
 * import boundaries and produces the exact bundles the daemon would load.
 *
 * Read-only use of the checkout: it only reads this plugin directory.
 *
 * Point it at any Paseo checkout (>=0.13.0). `tsx` is needed because the
 * compiler is TypeScript source:
 *
 *   CHECKOUT=$HOME/src/paseo npx --prefix "$CHECKOUT" tsx tests/compile-check.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHECKOUT = process.env.CHECKOUT ?? process.cwd();
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPILER = path.join(CHECKOUT, "packages/server/src/server/plugins/compiler.ts");

if (!existsSync(COMPILER)) {
  console.error(
    `No Paseo compiler at ${COMPILER}.\n` +
      "Set CHECKOUT to a Paseo checkout (>=0.13.0), e.g. CHECKOUT=$HOME/src/paseo",
  );
  process.exit(2);
}

const { compilePlugin } = await import(pathToFileURL(COMPILER).href);

const result = await compilePlugin({
  server: `${DIR}/index.server.ts`,
  client: `${DIR}/index.client.tsx`,
});

// The host validates every client contribution id against this exact pattern
// (packages/app/src/plugins/evaluate.ts, CONTRIBUTION_ID). One bad id throws
// inside contribute() and the host then discards the entire client bundle, so
// the plugin looks completely absent in the UI.
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;
const clientSource = readFileSync(path.join(DIR, "index.client.tsx"), "utf8");
const contributionIds = [
  // Inline ids, and the string constants the entry file passes as ids.
  ...clientSource.matchAll(/\b(?:id|name):\s*"([^"]+)"/g),
  ...clientSource.matchAll(/\bconst\s+[A-Z][A-Z0-9_]*(?:_ID|_PANEL_ID|_SETTINGS_ID)\s*=\s*"([^"]+)"/g),
].map((match) => match[1]);
const badContributionIds = contributionIds.filter((id) => !CONTRIBUTION_ID.test(id));

const report = {
  contributionIdsChecked: contributionIds.length,
  badContributionIds,
  serverBundleBytes: result.serverBundle?.length ?? 0,
  clientBundleBytes: result.clientBundle?.length ?? 0,
  serverHasContribute: /function contribute|contribute as default|exports\.default/.test(
    result.serverBundle ?? "",
  ),
  serverRegistersSessionOpen: (result.serverBundle ?? "").includes("agent.session_open"),
  serverHasKillGuard: (result.serverBundle ?? "").includes("isOwnSessionName"),
  clientHasAgentPanel: (result.clientBundle ?? "").includes("addAgentPanel"),
  clientHasRpcNames: ["session-status", "list-panes", "capture-pane", "select-pane", "kill-pane", "open-attach-terminal"].filter(
    (name) => (result.clientBundle ?? "").includes(name),
  ),
  serverHasRpcNames: ["session-status", "list-panes", "capture-pane", "select-pane", "kill-pane", "open-attach-terminal"].filter(
    (name) => (result.serverBundle ?? "").includes(name),
  ),
};

console.log(JSON.stringify(report, null, 2));

const ok =
  report.serverBundleBytes > 1000 &&
  report.clientBundleBytes > 1000 &&
  report.serverHasContribute &&
  report.serverRegistersSessionOpen &&
  report.clientHasAgentPanel &&
  report.serverHasRpcNames.length === 6 &&
  report.clientHasRpcNames.length === 6 &&
  report.contributionIdsChecked >= 6 &&
  report.badContributionIds.length === 0;

console.log(`compile-check: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
