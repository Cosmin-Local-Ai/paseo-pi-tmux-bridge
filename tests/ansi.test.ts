import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TAB_WIDTH,
  PASEO_DARK_TERMINAL_ANSI,
  PASEO_LIGHT_TERMINAL_ANSI,
  ansiLinesToPlain,
  buildTerminalPalette,
  buildThemePalette,
  parseAnsi,
  resolveInverse,
  sanitizeCapture,
} from "../shared/ansi.ts";
import type { AnsiPalette } from "../shared/ansi.ts";

const palette = buildTerminalPalette();

const ESC = "\x1b";

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------

test("terminal palette is a full 256-entry hex table with Paseo defaults", () => {
  assert.equal(palette.colors.length, 256);
  assert.ok(palette.colors.every((color) => /^#[0-9a-f]{6}$/.test(color)));
  // Paseo DEFAULT_TERMINAL_THEME fallbacks (colors.ts:211-212).
  assert.equal(palette.defaultFg, "#fafafa");
  assert.equal(palette.defaultBg, "#181b1a");
  // 6x6x6 cube step at index 16 is pure black, index 231 pure white.
  assert.equal(palette.colors[16], "#000000");
  assert.equal(palette.colors[231], "#ffffff");
  // Grey ramp start/end (colors.ts:78-80).
  assert.equal(palette.colors[232], "#080808");
  assert.equal(palette.colors[255], "#eeeeee");
});

test("base 16 mirrors Paseo dark and light terminal sets", () => {
  assert.equal(PASEO_DARK_TERMINAL_ANSI.length, 16);
  assert.equal(PASEO_LIGHT_TERMINAL_ANSI.length, 16);
  assert.equal(buildTerminalPalette("dark").colors[1], "#e07070"); // darkTerminalAnsi red
  assert.equal(buildTerminalPalette("dark").colors[9], "#e89090"); // brightRed
  assert.equal(buildTerminalPalette("light").colors[1], "#dc2626"); // lightTerminalAnsi red
  assert.equal(buildTerminalPalette("light").colors[0], "#1a1a1e"); // light terminalBlack
  assert.equal(buildTerminalPalette("light").defaultBg, "#ffffff");
});

test("theme palette takes default fg/bg from the plugin theme", () => {
  const theme = {
    colors: {
      surface0: "#101012",
      surface1: "#18181b",
      foreground: "#f5f5f7",
      foregroundMuted: "#8b8b93",
      accent: "#20744a",
      border: "#26262b",
    },
  };
  const themed = buildThemePalette(theme);
  assert.equal(themed.defaultFg, "#f5f5f7");
  assert.equal(themed.defaultBg, "#101012");
  assert.equal(themed.colors.length, 256);
  // The 16 base colours stay Paseo's own, not theme-derived.
  assert.equal(themed.colors[4], PASEO_DARK_TERMINAL_ANSI[4]);
  assert.equal(buildThemePalette(theme, "light").colors[11], PASEO_LIGHT_TERMINAL_ANSI[11]);
  // A junk theme must not throw.
  const broken = buildThemePalette(undefined as never, "light");
  assert.equal(broken.defaultBg, "#ffffff");
});

// ---------------------------------------------------------------------------
// parseAnsi — colours
// ---------------------------------------------------------------------------

test("SGR 31 red round-trips to the palette entry for red", () => {
  const lines = parseAnsi(`${ESC}[31mred${ESC}[0m plain`, palette);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].runs, [
    { text: "red", fg: palette.colors[1] },
    { text: " plain" },
  ]);
  assert.equal(lines[0].runs[0].fg, "#e07070");
  assert.equal(lines[0].plain, "red plain");
});

test("background, bright colours and 90-97/100-107 map to the palette", () => {
  const lines = parseAnsi(`${ESC}[90mbright-black${ESC}[100m+bright-black-bg${ESC}[40m+black-bg${ESC}[0m`, palette);
  assert.deepEqual(lines[0].runs, [
    { text: "bright-black", fg: palette.colors[8] },
    { text: "+bright-black-bg", fg: palette.colors[8], bg: palette.colors[8] },
    { text: "+black-bg", fg: palette.colors[8], bg: palette.colors[0] },
  ]);
});

test("256-colour SGR 38;5;n and 48;5;n produce the right hex", () => {
  const lines = parseAnsi(`${ESC}[38;5;196m${ESC}[48;5;232mboth${ESC}[0m`, palette);
  assert.equal(lines[0].runs[0].fg, "#ff0000"); // cube (5,0,0)
  assert.equal(lines[0].runs[0].bg, "#080808"); // grey ramp start
  // Out-of-range index degrades to the default instead of throwing.
  const junk = parseAnsi(`${ESC}[38;5;999mx${ESC}[0m`, palette);
  assert.deepEqual(junk[0].runs, [{ text: "x" }]);
});

test("truecolour SGR 38;2;r;g;b and 48;2;r;g;b emit #rrggbb", () => {
  const lines = parseAnsi(`${ESC}[38;2;18;255;4m${ESC}[48;2;1;2;3mboth${ESC}[0m`, palette);
  assert.equal(lines[0].runs[0].fg, "#12ff04");
  assert.equal(lines[0].runs[0].bg, "#010203");
  // Clamped rather than rejected: tmux occasionally emits >255.
  const clamped = parseAnsi(`${ESC}[38;2;300;-5;7mx${ESC}[0m`, palette);
  assert.equal(clamped[0].runs[0].fg, "#ff0007");
});

test("39 and 49 return to the palette defaults", () => {
  const lines = parseAnsi(`${ESC}[31mred${ESC}[39mdefault-fg${ESC}[44mblue-bg${ESC}[49mdefault-bg`, palette);
  assert.deepEqual(lines[0].runs, [
    { text: "red", fg: palette.colors[1] },
    { text: "default-fg" },
    { text: "blue-bg", bg: palette.colors[4] },
    { text: "default-bg" },
  ]);
});

// ---------------------------------------------------------------------------
// parseAnsi — attributes
// ---------------------------------------------------------------------------

test("bold, dim, italic, underline, strike and inverse flags", () => {
  const lines = parseAnsi(
    `${ESC}[1mbold${ESC}[0;4munderline${ESC}[0;9mstrike${ESC}[0;3mitalic${ESC}[0;2mdim${ESC}[0;7minverse`,
    palette,
  );
  const [bold, underline, strike, italic, dim, inverse] = lines[0].runs;
  assert.equal(bold.bold, true);
  assert.equal(underline.underline, true);
  assert.equal(strike.strike, true);
  assert.equal(italic.italic, true);
  assert.equal(dim.dim, true);
  assert.equal(inverse.inverse, true);
  // Off equivalents.
  const off = parseAnsi(`${ESC}[1;2;3;4;7;9mon${ESC}[22;23;24;27;29moff`, palette);
  assert.deepEqual(off[0].runs[1], { text: "off" });
  // 21 clears bold on its own.
  const boldOff = parseAnsi(`${ESC}[1mon${ESC}[21moff`, palette);
  assert.deepEqual(boldOff[0].runs[1], { text: "off" });
});

test("resolveInverse swaps fg/bg, falls back to palette defaults, clears the flag", () => {
  const lines = parseAnsi(
    `${ESC}[31m${ESC}[44m${ESC}[7mboth${ESC}[0m mid ${ESC}[31m${ESC}[7mfg-only${ESC}[0m`,
    palette,
  );
  assert.equal(lines[0].runs[0].inverse, true);
  const both = resolveInverse(lines[0].runs[0], palette);
  assert.deepEqual(both, { text: "both", fg: palette.colors[4], bg: palette.colors[1] });
  assert.equal("inverse" in both, false);
  const fgOnly = resolveInverse(lines[0].runs[2], palette);
  assert.equal(fgOnly.fg, palette.defaultBg);
  assert.equal(fgOnly.bg, palette.colors[1]);
  assert.equal("inverse" in fgOnly, false);
  // Non-inverted runs pass through unchanged apart from the cleared flag.
  assert.deepEqual(resolveInverse({ text: "plain" }, palette), { text: "plain" });
});

test("SGR state carries across newlines and resets per parse call", () => {
  const lines = parseAnsi(`${ESC}[1;31mfirst\nsecond\n${ESC}[0mthird`, palette);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].runs, [{ text: "first", fg: palette.colors[1], bold: true }]);
  assert.deepEqual(lines[1].runs, [{ text: "second", fg: palette.colors[1], bold: true }]);
  assert.deepEqual(lines[2].runs, [{ text: "third" }]);
  // A fresh call starts clean.
  assert.deepEqual(parseAnsi("first", palette)[0].runs, [{ text: "first" }]);
});

test("trailing newline is not a row, interior blank rows are kept", () => {
  const lines = parseAnsi("a\n\nb\n", palette);
  assert.deepEqual(lines.map((line) => line.plain), ["a", "", "b"]);
});

test("empty input parses to zero lines", () => {
  assert.deepEqual(parseAnsi("", palette), []);
  assert.deepEqual(parseAnsi(undefined as never, palette), []);
  assert.deepEqual(parseAnsi("", buildThemePalette({ colors: {} as never })), []);
});

// ---------------------------------------------------------------------------
// malformed input
// ---------------------------------------------------------------------------

test("malformed and non-SGR sequences never throw and never leak escapes", () => {
  const junk = [
    `${ESC}[`,
    `${ESC}[5`,
    `${ESC}]0;window title\x07`,
    `${ESC}[2J`,
    `${ESC}[H`,
    `${ESC}[?25l`,
    `${ESC}[38;5m`,
    `${ESC}[38;2;10m`,
    `${ESC}[9999mtext`,
    `${ESC}`,
    `${ESC}7${ESC}8`,
    `${ESC}(B`,
    `${ESC}]0;unterminated`,
    `${ESC}[m`,
    `${ESC}[;31msemi`,
  ];
  for (const input of junk) {
    const lines = parseAnsi(input, palette);
    for (const line of lines) {
      assert.ok(!line.plain.includes(`${ESC}`), `escape leaked from ${JSON.stringify(input)}`);
      for (const run of line.runs) {
        assert.ok(!run.text.includes(`${ESC}`), `escape leaked into run from ${JSON.stringify(input)}`);
        assert.ok(!run.text.includes("["), `CSI bracket leaked from ${JSON.stringify(input)}`);
      }
    }
    assert.doesNotThrow(() => parseAnsi(input, palette));
  }
  // Text after a CSI with a non-SGR final byte survives as plain text.
  assert.deepEqual(parseAnsi(`${ESC}[5Aafter`, palette)[0].runs, [{ text: "after" }]);
  // A truncated CSI swallows the remainder of that line only.
  const twoLines = parseAnsi(`${ESC}[31ma\n${ESC}[3`, palette);
  assert.deepEqual(twoLines[0].runs, [{ text: "a", fg: palette.colors[1] }]);
  assert.deepEqual(twoLines[1].runs, []);
});

test("parseAnsi tolerates a broken palette instead of throwing", () => {
  const lines = parseAnsi(`${ESC}[31mred`, undefined as never);
  assert.equal(lines[0].runs[0].fg, buildTerminalPalette().colors[1]);
});

// ---------------------------------------------------------------------------
// sanitizeCapture
// ---------------------------------------------------------------------------

test("sanitizeCapture keeps SGR and strips everything else", () => {
  const raw =
    `${ESC}]0;tmux pane\x07` +
    `${ESC}[?1049h${ESC}[1;1H${ESC}[2J` +
    `${ESC}[1m${ESC}[31mERR${ESC}[0m ${ESC}[38;5;33mcode${ESC}[39m done\r\n` +
    `${ESC}[H${ESC}[A${ESC}7${ESC}8tail\x0c`;
  const result = sanitizeCapture(raw);
  assert.equal(
    result.text,
    `${ESC}[1m${ESC}[31mERR${ESC}[0m ${ESC}[38;5;33mcode${ESC}[39m done\ntail`,
  );
  assert.equal(result.truncated, false);
});

test("sanitizeCapture is idempotent", () => {
  const samples = [
    "",
    "\n\n\n",
    "plain text",
    "a\r\nb\r\n",
    "tabs\tin\tthe\tpane",
    `${ESC}]0;title\x07body${ESC}[31mred${ESC}[0m`,
    `${ESC}[1m${ESC}[48;5;236mstatus${ESC}[0m\x1b[?2004l`,
    `${ESC}[`,
    `${ESC}[5`,
    `${ESC}[38;2;1;2;3`,
    "trailing\n\n   \n\n",
    "a\tb\x00c\x7fd",
  ];
  for (const sample of samples) {
    const once = sanitizeCapture(sample);
    const twice = sanitizeCapture(once.text);
    assert.equal(twice.text, once.text, `not idempotent: ${JSON.stringify(sample)}`);
    assert.equal(twice.truncated, false);
    assert.equal(sanitizeCapture(twice.text).text, once.text);
  }
});

test("sanitizeCapture expands tabs to four spaces by default", () => {
  assert.equal(sanitizeCapture("a\tb").text, `a${" ".repeat(DEFAULT_TAB_WIDTH)}b`);
  assert.equal(sanitizeCapture("a\tb", { tabWidth: 2 }).text, "a  b");
  assert.equal(sanitizeCapture("a\tb", { tabWidth: 0 }).text, "ab");
  // Expansion is stable under a second pass.
  assert.equal(sanitizeCapture(sanitizeCapture("a\tb").text).text, "a    b");
});

test("sanitizeCapture collapses trailing blank rows and reports truncation", () => {
  const result = sanitizeCapture("row1\nrow2\n\n   \n\n");
  assert.equal(result.text, "row1\nrow2");
  assert.equal(sanitizeCapture("\n\n\n").text, "");
  assert.equal(sanitizeCapture("").text, "");
  assert.equal(sanitizeCapture("").truncated, false);

  const big = "x".repeat(5000);
  const cut = sanitizeCapture(big, { maxChars: 100 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 100);
  assert.equal(sanitizeCapture(cut.text).truncated, false);

  // A cut inside an SGR sequence must not leave a dangling escape behind.
  const colored = Array.from({ length: 40 }, () => `${ESC}[31mabcdef`).join("");
  // 58 lands three bytes into the sixth SGR sequence.
  const midCut = sanitizeCapture(colored, { maxChars: 58 });
  assert.equal(midCut.truncated, true);
  assert.ok(!/\x1b\[[0-?]*$/.test(midCut.text), "dangling SGR fragment survived the cut");
  assert.equal(midCut.text, `${ESC}[31mabcdef`.repeat(5));
  assert.equal(sanitizeCapture(midCut.text).text, midCut.text);

  // Line-boundary cut keeps whole rows.
  const rows = Array.from({ length: 200 }, (_, index) => `row-${index}`).join("\n");
  const rowCut = sanitizeCapture(rows, { maxChars: 12 });
  assert.equal(rowCut.truncated, true);
  assert.match(rowCut.text, /^row-0\nrow-1$/);
});

test("sanitizeCapture never throws on hostile input", () => {
  const hostile = [
    undefined as never,
    null as never,
    0 as never,
    {} as never,
    "\ud800", // lone surrogate
    "\x1b".repeat(1000),
    "\x1b]".repeat(500),
    `${ESC}]0;${"y".repeat(500)}`,
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => sanitizeCapture(input));
    const result = sanitizeCapture(input);
    assert.equal(typeof result.text, "string");
    assert.equal(typeof result.truncated, "boolean");
    assert.ok(!result.text.includes(`${ESC}]`));
  }
});

// ---------------------------------------------------------------------------
// realistic capture fixture
// ---------------------------------------------------------------------------

const TMUX_CAPTURE = [
  `${ESC}]0;pi-tmux-bridge\x07${ESC}[1m${ESC}[38;5;33mcosmin@work${ESC}[0m ${ESC}[34m~/paseo-plugins/pi-tmux-bridge${ESC}[0m ${ESC}[1m${ESC}[34m$${ESC}[0m npm test`,
  ``,
  `${ESC}[32m✔${ESC}[39m parses ansi runs ${ESC}[2m(0.041s)${ESC}[0m`,
  `${ESC}[31m✖${ESC}[39m leaks escapes ${ESC}[1m${ESC}[90m[2:12]${ESC}[29m${ESC}[0m`,
  `${ESC}[38;2;220;38;38mtruecolour failure${ESC}[39m`,
  ``,
  `${ESC}[1m${ESC}[48;5;236m${ESC}[38;5;252m[0] [main] 0:bash${ESC}[49m${ESC}[39m${ESC}[0m${ESC}[48;5;236m${ESC}[38;5;252m 1:zsh ${ESC}[0m`,
  ``,
].join("\n");

test("a realistic tmux -e capture sanitizes and parses to a stable structure", () => {
  const sanitized = sanitizeCapture(TMUX_CAPTURE);
  assert.equal(sanitized.truncated, false);
  assert.equal(sanitizeCapture(sanitized.text).text, sanitized.text);

  const lines = parseAnsi(sanitized.text, palette);
  // 8 rows minus the trailing blank row that tmux pads with.
  assert.equal(lines.length, 7);
  assert.deepEqual(
    lines.map((line) => line.plain),
    [
      "cosmin@work ~/paseo-plugins/pi-tmux-bridge $ npm test",
      "",
      "✔ parses ansi runs (0.041s)",
      "✖ leaks escapes [2:12]",
      "truecolour failure",
      "",
      "[0] [main] 0:bash 1:zsh ",
    ],
  );

  // Prompt line: bold + 256-colour user, SGR-34 path, bold $.
  const prompt = lines[0].runs;
  assert.deepEqual(prompt[0], { text: "cosmin@work", fg: palette.colors[33], bold: true });
  assert.deepEqual(prompt[1], { text: " " });
  assert.equal(prompt[2].text, "~/paseo-plugins/pi-tmux-bridge");
  assert.equal(prompt[2].fg, palette.colors[4]);
  assert.deepEqual(prompt[4], { text: "$", fg: palette.colors[4], bold: true });
  assert.deepEqual(prompt[5], { text: " npm test" });

  // Passing line: green mark, dim timing.
  assert.equal(lines[2].runs[0].fg, palette.colors[2]);
  assert.equal(lines[2].runs[2].dim, true);

  // Failing line: red mark, bright-black bold location.
  assert.equal(lines[3].runs[0].fg, palette.colors[1]);
  assert.deepEqual(lines[3].runs[2], { text: "[2:12]", fg: palette.colors[8], bold: true });

  // Truecolour row.
  assert.equal(lines[4].runs[0].fg, "#dc2626");

  // Status row: bg colour across the whole row, no inverse flag.
  const status = lines[6];
  assert.equal(status.runs.length, 2);
  assert.equal(status.runs[0].bg, palette.colors[236]);
  assert.equal(status.runs[0].fg, palette.colors[252]);
  assert.equal(status.runs[0].bold, true);
  assert.equal(status.runs[1].bg, palette.colors[236]);
  assert.equal("inverse" in status.runs[0], false);

  // Plain text round trip, and the payload stays JSON-serialisable.
  assert.equal(
    ansiLinesToPlain(lines),
    [
      "cosmin@work ~/paseo-plugins/pi-tmux-bridge $ npm test",
      "",
      "✔ parses ansi runs (0.041s)",
      "✖ leaks escapes [2:12]",
      "truecolour failure",
      "",
      "[0] [main] 0:bash 1:zsh ",
    ].join("\n"),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), lines);
  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)), sanitized);

  // Sanity: the palette we assert against is a real AnsiPalette.
  const typed: AnsiPalette = palette;
  assert.equal(typed.colors[236], "#303030");
});

test("ansiLinesToPlain strips styling again, including for empty input", () => {
  assert.equal(ansiLinesToPlain([]), "");
  assert.equal(ansiLinesToPlain(parseAnsi("", palette)), "");
  assert.equal(ansiLinesToPlain(parseAnsi(`${ESC}[1;31ma\nb${ESC}[0m`, palette)), "a\nb");
  assert.equal(ansiLinesToPlain(undefined as never), "");
  assert.equal(ansiLinesToPlain([{ runs: undefined as never, plain: "x" }]), "");
});
