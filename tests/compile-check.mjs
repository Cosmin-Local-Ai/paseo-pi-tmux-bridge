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
import { existsSync } from "node:fs";
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

const report = {
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
  report.clientHasRpcNames.length === 6;

console.log(`compile-check: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
