# Pi subagent tracks never leave `running` when a third-party extension exposes a tool named `subagent`

Filed against Paseo server **0.13.2** (`packages/server`), source read from a clean checkout. Every
`file:line` below was read directly from that checkout and every command in the **Verification**
section has real output pasted in.

---

## Summary

The `pi-subagents` adapter claims tool calls by **tool name**, not by producer: `mapToolCall`
routes anything named `subagent` into `mapSpawn`
(`packages/server/src/server/agent/providers/pi/extensions/pi-subagents/index.ts:175`). A Pi
extension that is *not* `pi-subagents` but happens to expose a tool named `subagent` with
`{ agent, task }` arguments therefore passes the argument gate at `index.ts:127-129`, gets a
`status: "running"` upsert while it runs (`index.ts:143-144`), and then — because its result
`details` do not match the `pi-subagents` `Details` shape (`index.ts:27-35`) — falls into the
parse-failure branch at `index.ts:148-151`, which for a **completed** call returns `{ detail }`:
an update that carries **no `status`**. `ProviderSubagentStore.apply` keeps the previous status in
that case (`packages/server/src/server/agent/provider-subagents/store.ts:122`,
`status: event.status ?? previous?.status ?? "running"`), so the descriptor is pinned at
`"running"` forever. User-visible effect: the composer pill shows "N working" and never drains,
the row spins, and clicking it opens an empty timeline. Reproduced with
`amosblomqvist/pi-interactive-subagents`, whose spawn tool is also named `subagent` with
`{ agent, task }` args and pane-oriented result details.

---

## Root cause, step by step

All paths relative to `packages/server/src/server/`.

1. **Dispatch is by tool name.**
   `agent/providers/pi/extensions/pi-subagents/index.ts:173-177`

   ```ts
   mapToolCall(call) {
     if (call.toolName === "bg_wait") return mapWait(call);
     if (call.toolName === "subagent") return mapSpawn(call);
     return undefined;
   },
   ```

2. **The argument gate is shape-based, and the foreign tool satisfies it.**
   `index.ts:127-129`

   ```ts
   const args = Args.safeParse(call.args);
   if (!args.success || args.data.action !== undefined || !args.data.agent || !args.data.task)
     return undefined;
   ```

   `Args` (`index.ts:8-15`) is `.passthrough()` with `agent`, `task`, `async`, `action` all
   optional. `{ agent: "worker", task: "…", action: undefined }` passes.

3. **A row is created and marked running.** `index.ts:143-144`

   ```ts
   if (call.status === "running")
     return { detail, subagents: [{ ...base, status: "running" as const }] };
   ```

4. **On completion the result is parsed against the `pi-subagents` payload shape.**
   `Details` (`index.ts:27-35`) requires `mode: string` and `results: Row[]`, where `Row`
   (`index.ts:16-25`) carries `agent` and optionally `exitCode` / `success` / `sessionFile`.
   The parse happens at `index.ts:145-147`.

   Note that the *outer* result envelope does not strip foreign details:
   `PiToolResultDetailsSchema` is `.passthrough()`
   (`agent/providers/pi/tool-call-mapper.ts:156-160`), so the foreign `details` object reaches
   `Details.safeParse` intact and fails there.

5. **The parse-failure branch emits no status for a completed call.** `index.ts:148-151`

   ```ts
   if (!details.success || details.data.mode === "management")
     return call.status === "failed"
       ? { detail, subagents: [{ ...base, status: "failed" as const }] }
       : { detail };
   ```

   This is the asymmetry at the heart of the bug: the *same* unrecognised shape is treated as
   terminal when the call **failed** and as "say nothing" when the call **completed**.

6. **"Say nothing" means "stay running".**
   `agent/provider-subagents/store.ts:122`

   ```ts
   status: event.status ?? previous?.status ?? "running",
   ```

   The doc comment on the input event (`store.ts:32-36`) states this is deliberate — an omitted
   status must not revert a finished child. That is correct; it just means the adapter is the only
   thing that can end the track, and here it never does.

7. **The row is also permanently empty.** `store.ts:113` initialises a timeline for every upserted
   descriptor, but rows are only appended from `childSessions`, and `childSessions` is only ever
   built from `Row.sessionFile` (`index.ts:100-105` in `collectRows`) or from a parsed
   async/poll/notice path. A foreign result produces none, so the opened timeline has zero rows.

## Why the row can never leave `running`

`pi-subagents` has exactly three completion paths, and all three require a result that parsed
against `Details`:

| Path | Location | Why it cannot fire for a foreign extension |
| --- | --- | --- |
| `bg_wait` → `mapWait` | `index.ts:109-124` | Looks up `callsByRun`, which is populated only at `index.ts:152` from a parsed `details.runId`. Also needs the `bg_wait` tool, which only `pi-subagents` has. |
| `poll()` reading `status.json` | `index.ts:205-243` | Iterates `asyncRuns`, populated by `rememberAsyncRun` (`index.ts:76-80`) only when a parsed `details.asyncDir` exists. |
| `subagent-notify` custom message | `index.ts:178-203` | Requires `message.customType === "subagent-notify"` and an async-directory line registered in `asyncRuns`. A foreign extension emits its own custom types. |

So a foreign `subagent` call has **no** path to a terminal status. This is not a race or a
timing issue; it is structural.

---

## Minimal repro

A Pi extension that registers a tool named `subagent` with `{ agent, task }` args and returns
pane-oriented details:

```ts
// amosblomqvist/pi-interactive-subagents (abridged)
pi.registerTool({
  name: "subagent",
  parameters: { agent: Type.String(), task: Type.String() },
  async execute(_id, params) {
    const pane = spawnPane(params.agent, params.task);
    return {
      content: [{ type: "text", text: `${params.agent} finished` }],
      details: { paneId: pane.id, agent: params.agent, exitCode: 0, transcripts: [] },
    };
  },
});
```

Steps in the app:

1. Install `amosblomqvist/pi-interactive-subagents` in a Pi session Paseo drives.
2. Ask the agent to delegate: the extension calls `subagent({ agent, task })`.
3. Watch the composer pill: it shows "1 working" while the call runs (correct), and still shows
   "1 working" after the call returns (wrong). The row spins; clicking it opens an empty timeline.
4. Restart/reopen the session: still "1 working" — replay re-runs `mapSpawn` on the completed
   tool call and again emits no status.

The same scenario, as a unit test against Paseo's own test host, is in
**Regression test that would have caught this** below; it was run and fails on current `main`.

## Expected vs actual

| | Expected | Actual |
| --- | --- | --- |
| Pill | "1 working" while running, drains to 0 on completion | "1 working" forever |
| Descriptor status | terminal (`completed` / `failed`) once the tool call finishes | stuck at `running` (`store.ts:122`) |
| Row click | child timeline if the adapter knows the transcript, otherwise a settled row with the tool output | spinning row with an empty timeline |
| Replay after restart | same terminal status | stuck at `running` again |

---

## Proposed fix (primary)

Settle the descriptor when the result shape is **not** the `pi-subagents` protocol. A completed
call becomes `completed`, a failed one stays `failed`. This generalises the rule Paseo already
applies at `index.ts:149-150` (a failed spawn with no recognised rows finishes its descriptor) to
the completed case.

Patch: [`pi-subagents-finalize.patch`](./pi-subagents-finalize.patch) (+17 / −4).

```diff
+/**
+ * Status for a completed `subagent` call whose result does not match the pi-subagents protocol.
+ * Such a track has no other completion path: `poll()` and the `subagent-notify` notice follow only
+ * runs registered from a parsed `details`, and `bg_wait` needs a runId from one. A foreign
+ * extension that names its spawn tool `subagent` lands here, so settle it instead of leaving it
+ * running forever.
+ */
+function unrecognizedResultStatus(
+  callStatus: PiExtensionToolCall["status"],
+  detailsMatch: boolean,
+): "failed" | "completed" | undefined {
+  if (callStatus === "failed") return "failed";
+  return detailsMatch ? undefined : "completed";
+}
@@
-      if (!details.success || details.data.mode === "management")
-        return call.status === "failed"
-          ? { detail, subagents: [{ ...base, status: "failed" as const }] }
-          : { detail };
+      if (!details.success || details.data.mode === "management") {
+        const status = unrecognizedResultStatus(call.status, details.success);
+        return status ? { detail, subagents: [{ ...base, status }] } : { detail };
+      }
```

### Why this cannot double-finalize a genuine `pi-subagents` run

The new status is produced **only** when `details.success === false`. Every genuine
`pi-subagents` result parses:

- **foreground run** → `mode` + non-empty `results` → falls through to `collectRows`
  (`index.ts:167-170`), untouched;
- **async spawn** → `mode` + `asyncId` + `results: []` → keeps `status: "running"`
  (`index.ts:153-163`) and is later settled by `poll()` or the `subagent-notify` notice, untouched;
- **management result** → parses, so `details.success === true`, so `unrecognizedResultStatus`
  returns `undefined` and the branch still returns `{ detail }` exactly as before. This case is
  not hypothetical: the captured fixture `extensions/pi-subagents/fixtures/wait.json` contains
  two `"mode": "management"` results, and the `bg_wait` suite that reads it still passes.

Because the branch keeps its original `||`, no decision points were added inside `mapSpawn`. A
first draft that split the condition into two `if`s was rejected by the repo's own linter
(`eslint(complexity): function has a complexity of 21. Maximum allowed is 20.`); the helper form
is what makes `oxlint` clean. The helper sits next to the existing module-level helpers
`asyncChildStatus` (`index.ts:51-57`) and `noticeStatus` (`index.ts:60-69`).

### Trade-off accepted

Marking a completed-but-unrecognised call `completed` could in principle mark a real child
`completed` while it still runs in the background — if `pi-subagents` ever returned a
non-conforming result for a live run. That is the same bet Paseo already makes for the `failed`
case at `index.ts:149-150`, and it is strictly better than the alternative, which is a track that
is *guaranteed* never to settle. The row still shows the tool's own text output via `detail.log`
(`index.ts:130-135`), so the information is not lost. It does not produce a child timeline,
because Paseo has no transcript path to read — that remains a separate enhancement.

---

## Alternative (B): do not create the track until the shape is recognised

Move the gate so no row exists until `Details` parses — i.e. return `undefined` at
`index.ts:143-144` as well, or emit the first upsert only from the recognised completion path.

Downside, from the code: at `index.ts:143` the result is not available yet, so the adapter cannot
know whether it will ever recognise the shape. Suppressing the running upsert therefore also
suppresses the running row for **real** `pi-subagents` spawns, which is precisely the feature:
the async suite at `extensions/pi-subagents/index.test.ts:47-88` and the `wait.json` fixture
assert `"running"` upserts arrive before completion, and `subagent-fixture-test.ts:110-117`
asserts an upsert precedes the first child timeline event. Long or background delegations would
become invisible until they finished, and the "N working" pill — the thing users rely on — would
stop working. Option B trades a stuck pill for no pill at all.

A weaker variant of B, and the one Paseo already ships elsewhere, is to **delete** the row on an
unrecognised completed result: `gotgenes-pi-subagents/index.ts:85-89` returns
`{ detail, subagents: [{ type: "remove" as const, id: call.callId }] }` for exactly this case.
That does drain the pill, but `store.ts:88-91` deletes the descriptor *and* its timeline, so the
delegation vanishes from the subagent list entirely and the user gets no signal that a child ever
ran. Worth noting because it shows the maintainers have already hit this shape mismatch once; the
three adapters just resolved it three different ways (`pi-subagents` leaves it running,
`gotgenes` removes it, `tintinweb` returns `{ detail }` at
`tintinweb-pi-subagents/index.ts:115`).

---

## Third option: gate the adapter by extension identity, not tool name

`extensions/registry.ts:11-21` ships three subagent adapters:

- `pi-subagents` (`id: "pi-subagents"`)
- `tintinweb-pi-subagents` (`tintinwebPiSubagents`)
- `gotgenes-pi-subagents` (`id: "@gotgenes/pi-subagents"`)

and all three claim calls by name — `pi-subagents/index.ts:175` and
`gotgenes-pi-subagents/index.ts:136` both match `"subagent"`. `PiExtensionHost.mapToolCall`
(`extensions/host.ts:119-128`) is **first-wins in registry order**, so `pi-subagents` sees every
`subagent` call before `@gotgenes/pi-subagents` does. Today that is harmless only by accident:
gotgenes' `SpawnArgs` (`gotgenes-pi-subagents/index.ts:8-13`) require
`{ subagent_type, prompt }`, which `pi-subagents`' `Args` gate rejects, so `mapSpawn` returns
`undefined` and the call falls through. Any extension that *does* use `{ agent, task }` — the
amos extension — is captured, and Paseo has no way to tell it apart.

A structural fix would carry the producing extension identity into `PiExtensionToolCall`
(`extensions/contract.ts:11-17` exposes only `callId`, `toolName`, `args`, `status`, `result`) and
let an adapter require its own producer. That is the right long-term answer and would also make
the adapter order in `host.ts` non-semantic, but it needs new plumbing from the Pi integration
into the contract, so it is a larger change than this bug should block on. The behavioural fix
above is safe on its own; identity gating is the follow-up.

---

## Regression test that would have caught this

Written in the style of the existing `"a failed spawn without result rows finishes its descriptor"`
test at `extensions/pi-subagents/index.test.ts:245-275`, and using the same
`createPiExtensionHost()` helper as the rest of that file.

```ts
// packages/server/src/server/agent/providers/pi/extensions/pi-subagents/index.test.ts
test("a completed spawn with foreign result details finishes its descriptor", () => {
  const host = createPiExtensionHost();
  const args = { agent: "worker", task: "Open a pane and work" };
  host.mapToolCall({
    callId: "foreign",
    toolName: "subagent",
    args,
    status: "running",
    result: null,
  });
  expect(
    host.mapToolCall({
      callId: "foreign",
      toolName: "subagent",
      args,
      status: "completed",
      result: {
        content: [{ type: "text", text: "worker finished" }],
        details: { paneId: 3, agent: "worker", exitCode: 0, transcripts: [] },
      },
    })?.subagents,
  ).toEqual([
    {
      type: "upsert",
      id: "foreign",
      title: "worker",
      description: "Open a pane and work",
      toolCallId: "foreign",
      status: "completed",
    },
  ]);
});
```

The `details` deliberately omit `mode` and `results`, which is what `Details`
(`index.ts:27-35`) requires, so it reproduces the amos shape.

**Measured**, against this checkout:

- on **unpatched** `index.ts`: `FAIL … AssertionError: expected undefined to deeply equal [ { type: 'upsert', …(5) } ]` —
  i.e. `mapping.subagents` is `undefined`, the adapter says nothing about status.
- with the patch applied: `Test Files 1 passed (1) / Tests 1 passed | 9 skipped (10)`.

A second, store-level test is optional since the mechanism is already covered by
`provider-subagents/store.test.ts` ("keeps provider children and their timelines scoped to the
parent agent", which asserts a status omitted keeps the stored value); the defect is in the
adapter, not the store.

---

## Verification (measured, this checkout)

Paseo source: `/tmp/paseo-build`, `packages/server` (`@getpaseo/server` 0.13.2). Not a git
checkout, so files were backed up with `cp` and restored with `cp` + `cmp`; the patch itself was
applied with `git apply -p1` and reverted with `git apply -R -p1`. Nothing was committed, pushed,
or run against `~/.paseo`.

| Command | Result |
| --- | --- |
| `../../node_modules/.bin/vitest run <5 subagent test files>` (baseline, unpatched) | `Test Files 5 passed (5) / Tests 46 passed (46)` |
| `../../node_modules/.bin/tsgo -p tsconfig.server.typecheck.json --noEmit` (baseline) | exit 0, no output, 6.3 s |
| `../../node_modules/.bin/oxlint <index.ts>` (baseline) | `Found 0 warnings and 0 errors.` |
| same, first draft of the patch | `x eslint(complexity): function has a complexity of 21. Maximum allowed is 20.` → draft rejected |
| same, final patch | `Found 0 warnings and 0 errors.` |
| `../../node_modules/.bin/oxfmt --check <index.ts>` (final patch) | `All matched files use the correct format.` |
| `git apply --check -p1 pi-subagents-finalize.patch` | clean |
| `git apply -p1 pi-subagents-finalize.patch` | applied |
| `vitest run <5 subagent test files>` (patched) | `Test Files 5 passed (5) / Tests 46 passed (46)` |
| `vitest run src/server/agent/providers/pi src/server/agent/provider-subagents` (patched) | `Test Files 17 passed (17) / Tests 226 passed (226)` |
| `vitest run <regression test>` (unpatched) | `1 failed` — `expected undefined to deeply equal [...]` |
| `vitest run <regression test>` (patched) | `1 passed` |
| `tsgo -p tsconfig.server.typecheck.json --noEmit` (patched) | exit 0 |
| `vitest run --exclude "**/*.e2e.test.ts"` (patched, **whole server unit suite**) | `Test Files 4 failed / 436 passed / 3 skipped (443)` — `Tests 5 failed / 6775 passed / 54 skipped (6834)`, 620 s |
| those same 4 files, **unpatched** baseline | `Test Files 4 failed (4) / Tests 5 failed / 159 passed (164)` — identical 5 failures, so they are pre-existing and environment-related |
| `git apply -R --check -p1` after restore | clean |

Restore proof: `cmp index.ts index.ts.orig` and `cmp index.test.ts index.test.ts.orig` both silent;
`md5sum` of the restored `index.ts` equals the md5 taken before any edit
(`899f94354106d52f41ac01576fb3985f`); no `*.orig` files remain under `/tmp/paseo-build`.

The five failures in the full unit suite are, verbatim:

```
× resolves the installed Claude Code version
× shutdown closes Claude and its process despite a reject peer and stalled SDK handshake
× shutdown closes Claude and its process despite a stall peer and stalled SDK handshake
× config options reach Claude and provider validation reaches the create caller
× reports an overridden command and OMP-only paths and caveats
```

They fail in `claude/agent.test.ts`, `bootstrap.smoke.test.ts`, `provider-options.test.ts` and
`omp/agent.diagnostic.test.ts`, with stack frames at `agent-manager.ts:5406`
(`requireAvailableClient`) and `providers/claude/agent.ts:1890`
(`resolveClaudeCodeVersion`) — they need the Claude Code / OMP CLIs, which are not installed in
this container. I re-ran exactly those four files on the **unpatched** tree and got the same five
failures, so they are not caused by this patch. No Pi or subagent test fails in the full suite.

The narrow, fast, directly-relevant command a reviewer should run is:

```bash
cd packages/server
../../node_modules/.bin/vitest run \
  src/server/agent/providers/pi src/server/agent/provider-subagents
# patched: Test Files 17 passed (17) / Tests 226 passed (226) — 4.6 s
```

---

## For the reporter

This patch does **not** help today. Paseo is being run from the packaged AppImage, whose server is
inside the bundled `app.asar`; editing or patching `packages/server` sources on disk changes
nothing until Paseo ships a build that includes the fix, and the AppImage must then be updated.
There is no supported way to hot-patch the installed server, and `~/.paseo` holds session state,
not server code.

Workarounds available right now, in rough order of least friction:

1. **Disable or unload `amosblomqvist/pi-interactive-subagents`** in that Pi session and use
   `pi-subagents` (which Paseo understands), or Paseo's own subagents.
2. **Rename the extension's tool** (e.g. `interactive_subagent`) if you control a fork. Paseo's
   gate is literally `call.toolName === "subagent"`, so any other name leaves the track alone and
   the pill stays clean — at the cost of no subagent rows for that extension at all.
3. Wait for the upstream fix.

---

## Corrections to the diagnosis as briefed

The diagnosis is correct on every load-bearing point (name-based dispatch at `index.ts:175`, the
args gate at `index.ts:127-129`, the `running` upsert, `Details` at `index.ts:27-35`, the
status-less `{ detail }` return, `store.ts:122` pinning `running`, and the empty timeline). Two
refinements:

1. **Not every unrecognised completion is stuck.** The same branch at `index.ts:149-150` already
   emits `status: "failed"` when `call.status === "failed"`. Only *completed* calls leak. That is
   why the fix is a three-line generalisation rather than new logic, and why the regression test
   mirrors the existing failed-spawn test.
2. **`mode === "management"` must stay as-is.** The briefed condition is
   `!details.success || details.data.mode === "management"`; a management result *does* parse, and
   the captured `wait.json` fixture contains two of them. Splitting the condition naively would
   have changed management behaviour and risked those fixtures. The patch keeps that arm returning
   `{ detail }` unchanged.

One related latent issue, not fixed here: because `host.ts:119-128` is first-wins and both
`pi-subagents` and `@gotgenes/pi-subagents` match the tool name `subagent`, adapter order in
`registry.ts:11-21` is currently semantic. It only works today because their argument shapes are
disjoint.

---

## Verified against the reporter's actual extension

Read directly from `amosblomqvist/pi-interactive-subagents` as installed on the reporter's
machine (`pi-extension/subagents/index.ts`), not from inference:

- The spawn tool is registered under the name **`subagent`** (`SPAWNING_TOOLS`, `index.ts:159`), so it
  is gated by `pi-subagents/index.ts:175`.
- Its success result is:

  ```ts
  details: { id, name, task, agent, sessionFile, launchScriptFile, status: "started" }
  ```

  (`index.ts:1905`–`1913`)
- `grep -c "results:" index.ts` → **0**; `mode:` appears once and is unrelated. `Details` requires both
  (`mode: z.string()`, `results: z.array(Row)`), so **`Details.safeParse` fails on every Amos spawn**.
  That is exactly the branch this patch changes — the leak is not hypothetical for this extension.
- Only the spawn path leaks: the gate matches `subagent` alone, so `subagent_message` and
  `subagents_list` never create rows.

### A second, higher-value fix the same evidence exposes

Amos already returns **`sessionFile`** — the child's append-only JSONL transcript. Paseo already has
the machinery to follow exactly that (`PiChildSessionFollower`, reported as
`childSessions: [{ id, file }]`). Recognising this shape and emitting `childSessions` would give
foreign-extension subagents a **real timeline** instead of the empty one the reporter sees when they
click a row.

Honest caveat so nobody declares that a complete fix: the reporter's agents run **inside a container**,
so `sessionFile` is a path inside the sandbox. `mapPiChildSession` opens it with host `node:fs`, which
cannot see it. For sandboxed agents the transcript would have to be read through the same namespace
prefix the rest of the integration uses — otherwise the row fills up with nothing, which is the
symptom being reported.
