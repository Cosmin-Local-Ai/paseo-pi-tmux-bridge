/**
 * ANSI colour layer for tmux pane captures.
 *
 * The plugin used to render `tmux capture-pane -p` output as plain monospace
 * text, which throws away every colour the pane actually has. This module turns
 * the output of `tmux capture-pane -p -e -S -N` into JSON-serialisable styled
 * runs that the React Native panel can map onto nested <Text> elements.
 *
 * Deliberately dependency-free and side-effect-free: no React, no DOM, no
 * react-native import, no functions in the output payload. Everything here is
 * pure string -> data, so it is unit-testable under `node --test` and safe to
 * hand across the plugin RPC boundary.
 *
 * Palette provenance is documented next to each value group; anything not taken
 * verbatim from Paseo is marked `// chosen, not from Paseo`.
 */

// ---------------------------------------------------------------------------
// Types (JSON-serialisable by construction)
// ---------------------------------------------------------------------------

/** A single run of text that shares one style. `fg`/`bg` are `#rrggbb`. */
export interface AnsiRun {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

/** One screen row: styled runs plus the same text with styling stripped. */
export interface AnsiLine {
  runs: AnsiRun[];
  plain: string;
}

/** Colour lookup used while parsing: 256 indexed colours plus the defaults. */
export interface AnsiPalette {
  /** Index 0..255 -> `#rrggbb`. Always exactly 256 entries. */
  colors: string[];
  /** What SGR 39 (default foreground) resolves to. */
  defaultFg: string;
  /** What SGR 49 (default background) resolves to. */
  defaultBg: string;
}

/** Paseo authors two ANSI sets: one for dark themes, one for light themes. */
export type AnsiVariant = "dark" | "light";

/**
 * The subset of the Paseo plugin theme this module needs. `PluginTheme`
 * (packages/plugin/src/contracts.ts:6) is structurally wider, so the panel's
 * `theme` prop can be passed straight in.
 */
export interface PaseoThemeLike {
  colors: {
    surface0: string;
    surface1: string;
    foreground: string;
    foregroundMuted: string;
    accent: string;
    border: string;
  };
}

export interface SanitizeOptions {
  /** Hard cap on the returned text length. Default {@link DEFAULT_MAX_CHARS}. */
  maxChars?: number;
  /** Spaces a tab expands to. Default {@link DEFAULT_TAB_WIDTH}. */
  tabWidth?: number;
}

/**
 * `truncated` is reported instead of silently cutting: the caller decides
 * whether to ask tmux for fewer lines.
 */
export interface SanitizedCapture {
  text: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Palette data mirrored from Paseo
// ---------------------------------------------------------------------------

/**
 * Paseo's 6x6x6 colour cube steps and the 24-step grey ramp, copied from
 * /tmp/paseo-build/packages/app/src/terminal/native-renderer/colors.ts:27
 * (`CUBE_LEVELS`) and colors.ts:71-81 (`build256Palette`). The index arithmetic
 * `16 + r*36 + g*6 + b` and `232 + i` with `value = 8 + i*10` is Paseo's too.
 * Paseo renders those as `rgb(r, g, b)` strings; here they are normalised to
 * `#rrggbb` because the plugin sets them on React Native `Text` styles. The
 * numeric values are identical.
 */
const CUBE_LEVELS = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];

/**
 * ANSI 0-15 for every Paseo *dark* theme.
 * Source: /tmp/paseo-build/packages/app/src/styles/theme.ts:373-389
 * (`darkTerminalAnsi`). This one object is shared by all five dark tints
 * (paseo, zinc, midnight, claude, ghostty) and by pureBlack — they differ only
 * in `black`/`brightBlack` (see `PASEO_DARK_TERMINAL_BLACK_*` below).
 * Order matches Paseo's `ANSI_THEME_KEYS` (colors.ts:8-24).
 */
export const PASEO_DARK_TERMINAL_ANSI: readonly string[] = [
  "#141716", // black        — paseoDarkColors terminalBlack, theme.ts:475
  "#e07070", // red          — darkTerminalAnsi, theme.ts:374
  "#5dba80", // green        — darkTerminalAnsi, theme.ts:375
  "#d4a44a", // yellow       — darkTerminalAnsi, theme.ts:376
  "#6a9de0", // blue         — darkTerminalAnsi, theme.ts:377
  "#b07ad0", // magenta      — darkTerminalAnsi, theme.ts:378
  "#4aabb8", // cyan         — darkTerminalAnsi, theme.ts:379
  "#d4d4d8", // white        — darkTerminalAnsi, theme.ts:380
  "#434645", // brightBlack  — paseoDarkColors terminalBrightBlack, theme.ts:476
  "#e89090", // brightRed    — darkTerminalAnsi, theme.ts:381
  "#7ecf9a", // brightGreen  — darkTerminalAnsi, theme.ts:382
  "#e0be6e", // brightYellow — darkTerminalAnsi, theme.ts:383
  "#8ab4e8", // brightBlue   — darkTerminalAnsi, theme.ts:384
  "#c49ae0", // brightMagenta- darkTerminalAnsi, theme.ts:385
  "#6ec2cc", // brightCyan   — darkTerminalAnsi, theme.ts:386
  "#f0f0f2", // brightWhite  — darkTerminalAnsi, theme.ts:387
];

/**
 * ANSI 0-15 for Paseo's *light* theme.
 * Source: /tmp/paseo-build/packages/app/src/styles/theme.ts:244-260
 * (`lightTerminalAnsi`) plus `lightSemanticColors` terminalBlack /
 * terminalBrightBlack at theme.ts:342-343.
 */
export const PASEO_LIGHT_TERMINAL_ANSI: readonly string[] = [
  "#1a1a1e", // black        — lightSemanticColors terminalBlack, theme.ts:342
  "#dc2626", // red          — lightTerminalAnsi, theme.ts:245
  "#16a34a", // green        — lightTerminalAnsi, theme.ts:246
  "#ca8a04", // yellow       — lightTerminalAnsi, theme.ts:247
  "#2563eb", // blue         — lightTerminalAnsi, theme.ts:248
  "#9333ea", // magenta      — lightTerminalAnsi, theme.ts:249
  "#0891b2", // cyan         — lightTerminalAnsi, theme.ts:250
  "#ffffff", // white        — lightTerminalAnsi, theme.ts:251
  "#3f3f46", // brightBlack  — lightSemanticColors terminalBrightBlack, theme.ts:343
  "#ef4444", // brightRed    — lightTerminalAnsi, theme.ts:252
  "#22c55e", // brightGreen  — lightTerminalAnsi, theme.ts:253
  "#f59e0b", // brightYellow — lightTerminalAnsi, theme.ts:254
  "#3b82f6", // brightBlue   — lightTerminalAnsi, theme.ts:255
  "#a855f7", // brightMagenta- lightTerminalAnsi, theme.ts:256
  "#06b6d4", // brightCyan   — lightTerminalAnsi, theme.ts:257
  "#fafafa", // brightWhite  — lightTerminalAnsi, theme.ts:258
];

/**
 * Paseo's default terminal fg/bg, i.e. `DEFAULT_TERMINAL_THEME`
 * (colors.ts:58 = `toXtermTheme(darkTheme.colors.terminal)`) and the literal
 * fallbacks in `createTerminalCellStyleResolver` (colors.ts:211-212:
 * `?? "#fafafa"` and `?? "#181B1A"`).
 */
const PASEO_DEFAULT_TERMINAL_FG = "#fafafa"; // colors.ts:211
const PASEO_DEFAULT_TERMINAL_BG = "#181b1a"; // colors.ts:212 (surface0, theme.ts:461)

function hex2(value: number): string {
  const clamped = value < 0 ? 0 : value > 255 ? 255 : value | 0;
  return clamped.toString(16).padStart(2, "0");
}

function toHex(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * Build the full 256-entry table from the 16 base colours, using Paseo's cube
 * and grey-ramp arithmetic. Indices 0-15 come from `base16`, 16-231 are the
 * 6x6x6 cube, 232-255 the grey ramp.
 */
function build256(base16: readonly string[]): string[] {
  const colors: string[] = new Array<string>(256);
  for (let index = 0; index < 16; index += 1) {
    colors[index] = base16[index] ?? "#000000";
  }
  for (let r = 0; r < CUBE_LEVELS.length; r += 1) {
    for (let g = 0; g < CUBE_LEVELS.length; g += 1) {
      for (let b = 0; b < CUBE_LEVELS.length; b += 1) {
        colors[16 + r * 36 + g * 6 + b] = toHex(CUBE_LEVELS[r], CUBE_LEVELS[g], CUBE_LEVELS[b]);
      }
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    colors[232 + index] = toHex(value, value, value);
  }
  return colors;
}

/**
 * The palette Paseo falls back to when no theme is supplied: its own dark
 * terminal theme (`DEFAULT_TERMINAL_THEME`). Use this when there is no theme to
 * adapt to — it is what Paseo's terminal shows out of the box.
 */
export function buildTerminalPalette(variant: AnsiVariant = "dark"): AnsiPalette {
  const base = variant === "light" ? PASEO_LIGHT_TERMINAL_ANSI : PASEO_DARK_TERMINAL_ANSI;
  return {
    colors: build256(base),
    defaultFg: variant === "light" ? "#1a1a1e" : PASEO_DEFAULT_TERMINAL_FG,
    defaultBg: variant === "light" ? "#ffffff" : PASEO_DEFAULT_TERMINAL_BG,
  };
}

/**
 * Palette adapted to the plugin's own theme, so a pane looks like part of Paseo
 * rather than like a random xterm.
 *
 * The 16 base ANSI colours are Paseo's literals (`darkTerminalAnsi` /
 * `lightTerminalAnsi` in styles/theme.ts) — the plugin theme does not expose
 * `colors.terminal`, so they cannot be read from it; the variant argument picks
 * which set to use, exactly as Paseo keeps a dark and a light set. The
 * default fg/bg *do* come from the plugin theme, mirroring how Paseo derives
 * `colors.terminal.foreground` from `colors.foreground` and
 * `colors.terminal.background` from `colors.surface0` (theme.ts:309-313 for
 * light, theme.ts:441-445 for dark).
 *
 * `surface1` / `foregroundMuted` / `accent` / `border` are accepted because the
 * caller passes the whole theme object; they are intentionally unused — Paseo
 * does not map them onto ANSI colours.
 */
export function buildThemePalette(theme: PaseoThemeLike, variant: AnsiVariant = "dark"): AnsiPalette {
  const colors = theme && theme.colors ? theme.colors : undefined;
  const base = variant === "light" ? PASEO_LIGHT_TERMINAL_ANSI : PASEO_DARK_TERMINAL_ANSI;
  const fallback = buildTerminalPalette(variant);
  return {
    colors: build256(base),
    defaultFg: pickHex(colors && colors.foreground) ?? fallback.defaultFg,
    defaultBg: pickHex(colors && colors.surface0) ?? fallback.defaultBg,
  };
}

function pickHex(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// sanitizeCapture
// ---------------------------------------------------------------------------

/** Defensive cap; a 2000-line pane capture is well under this. */
export const DEFAULT_MAX_CHARS = 1_000_000; // chosen, not from Paseo

/** tmux pane content is already column-aligned, so tabs are rare. */
export const DEFAULT_TAB_WIDTH = 4; // chosen, not from Paseo

function trimTrailingBlankLines(text: string): string {
  let end = text.length;
  while (end > 0) {
    const lineStart = text.lastIndexOf("\n", end - 1);
    const line = text.slice(lineStart + 1, end);
    if (line.length === 0 || /^ +$/.test(line)) {
      end = lineStart <= 0 ? (lineStart === -1 ? 0 : lineStart) : lineStart;
      continue;
    }
    break;
  }
  return text.slice(0, end);
}

// A cut can land inside an escape sequence; dropping the dangling tail keeps
// sanitizeCapture idempotent. A complete SGR ends in `m` (0x6d), which is in
// none of these byte classes and is not followed by end-of-input, so kept
// sequences are never matched.
const DANGLING_CSI_PARAMS = /\x1b\[[0-?]*$/; // params then EOF (0x30-0x3f)
const DANGLING_CSI_INTERMEDIATES = /\x1b\[[0-?]*[ -/]+$/; // intermediates then EOF (0x20-0x2f)
const DANGLING_STRING_ESCAPE = /\x1b[PX^_\]]$/; // unterminated OSC/DCS/SOS/PM/APC opener
const DANGLING_LONE_ESC = /\x1b$/;

function looksDangling(text: string): boolean {
  return (
    DANGLING_CSI_PARAMS.test(text) ||
    DANGLING_CSI_INTERMEDIATES.test(text) ||
    DANGLING_STRING_ESCAPE.test(text) ||
    DANGLING_LONE_ESC.test(text)
  );
}

function stripDanglingEscape(text: string): string {
  if (!looksDangling(text)) return text;
  const index = text.lastIndexOf("\x1b");
  return index === -1 ? text : text.slice(0, index);
}

/**
 * Normalise `tmux capture-pane -p -e` stdout for the parser.
 *
 * Kept: SGR sequences (`CSI ... m`) and printable text plus `\n`.
 * Removed: every other CSI (cursor movement, erase, DEC private modes such as
 * `?25l`), OSC (window title), DCS/SOS/PM/APC, two-char escapes (cursor save /
 * restore, charset selection, reset), lone ESC, CR, other C0 controls and DEL.
 * Tabs expand to `tabWidth` spaces.
 *
 * Never throws, and `sanitizeCapture(sanitizeCapture(x).text).text === sanitizeCapture(x).text`.
 */
export function sanitizeCapture(raw: string, options: SanitizeOptions = {}): SanitizedCapture {
  const maxChars =
    typeof options.maxChars === "number" && Number.isFinite(options.maxChars) && options.maxChars >= 0
      ? Math.trunc(options.maxChars)
      : DEFAULT_MAX_CHARS;
  const tabWidth =
    typeof options.tabWidth === "number" && Number.isFinite(options.tabWidth) && options.tabWidth >= 0
      ? Math.trunc(options.tabWidth)
      : DEFAULT_TAB_WIDTH;

  if (typeof raw !== "string" || raw.length === 0) {
    return { text: "", truncated: false };
  }

  const out: string[] = [];
  const tabs = tabWidth > 0 ? " ".repeat(tabWidth) : "";
  const n = raw.length;
  let i = 0;

  while (i < n) {
    const ch = raw[i];

    if (ch === "\x1b") {
      const next = i + 1 < n ? raw[i + 1] : undefined;

      if (next === "[") {
        // CSI: parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e.
        let j = i + 2;
        while (j < n) {
          const code = raw.charCodeAt(j);
          if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
            j += 1;
            continue;
          }
          break;
        }
        if (j < n && raw.charCodeAt(j) >= 0x40 && raw.charCodeAt(j) <= 0x7e) {
          if (raw[j] === "m") out.push(raw.slice(i, j + 1)); // keep SGR only
          i = j + 1;
        } else {
          i = n; // unterminated CSI at EOF: drop the fragment
        }
        continue;
      }

      if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        // OSC / DCS / SOS / PM / APC — terminated by BEL or ST (ESC \).
        let j = i + 2;
        while (j < n) {
          if (raw[j] === "\x07") {
            j += 1;
            break;
          }
          if (raw[j] === "\x1b" && raw[j + 1] === "\\") {
            j += 2;
            break;
          }
          if (raw[j] === "\n") break; // unterminated: never eat the rest of the screen
          j += 1;
        }
        i = j;
        continue;
      }

      if (next === undefined) {
        i = n; // lone trailing ESC
        continue;
      }

      if (next === "(" || next === ")" || next === "*" || next === "+" || next === "#" || next === "%") {
        i += 3; // charset / designator sequences
        continue;
      }

      i += 2; // ESC 7, ESC 8, ESC c, ESC =, ... all dropped
      continue;
    }

    if (ch === "\n") {
      out.push("\n");
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1; // CR is line-overwrite junk; tmux rows are already final
      continue;
    }
    if (ch === "\t") {
      out.push(tabs);
      i += 1;
      continue;
    }
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      i += 1; // NUL, BEL, BS, VT, FF, DEL, ...
      continue;
    }
    out.push(ch);
    i += 1;
  }

  let text = trimTrailingBlankLines(out.join(""));
  let truncated = false;

  if (text.length > maxChars) {
    const cut = text.lastIndexOf("\n", maxChars);
    text = cut > 0 ? text.slice(0, cut) : stripDanglingEscape(text.slice(0, maxChars));
    text = trimTrailingBlankLines(text);
    truncated = true;
  }

  return { text, truncated };
}

// ---------------------------------------------------------------------------
// parseAnsi
// ---------------------------------------------------------------------------

interface SgrState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

function isUsablePalette(palette: AnsiPalette | undefined | null): palette is AnsiPalette {
  return !!palette && Array.isArray(palette.colors) && palette.colors.length >= 16;
}

function indexed(palette: AnsiPalette, value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
  return palette.colors[value] ?? undefined;
}

/** Apply one SGR sequence's parameters to the running style state. */
function applySgr(raw: string, state: SgrState, palette: AnsiPalette): void {
  // Some emitters use ':' between the extended-colour sub-parameters.
  const parts = raw.includes(":") ? raw.split(":") : raw.split(";");
  const params: number[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") {
      params.push(0); // `ESC[m`, `ESC[;31m` -> 0
      continue;
    }
    const parsed = Number.parseInt(trimmed, 10);
    params.push(Number.isFinite(parsed) ? parsed : -1);
  }
  if (params.length === 0) params.push(0);

  for (let i = 0; i < params.length; i += 1) {
    const code = params[i];

    if (code === 0) {
      state.fg = undefined;
      state.bg = undefined;
      state.bold = false;
      state.dim = false;
      state.italic = false;
      state.underline = false;
      state.inverse = false;
      state.strike = false;
      continue;
    }
    if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 9) state.strike = true;
    else if (code === 21 || code === 22) {
      state.bold = false;
      if (code === 22) state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 29) state.strike = false;
    else if (code === 39) state.fg = undefined;
    else if (code === 49) state.bg = undefined;
    else if (code >= 30 && code <= 37) state.fg = indexed(palette, code - 30) ?? state.fg;
    else if (code >= 40 && code <= 47) state.bg = indexed(palette, code - 40) ?? state.bg;
    else if (code >= 90 && code <= 97) state.fg = indexed(palette, code - 90 + 8) ?? state.fg;
    else if (code >= 100 && code <= 107) state.bg = indexed(palette, code - 100 + 8) ?? state.bg;
    else if (code === 38 || code === 48) {
      const kind = params[i + 1];
      if (kind === 5) {
        const color = indexed(palette, params[i + 2]);
        state[code === 38 ? "fg" : "bg"] = color;
        i += 2;
      } else if (kind === 2) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        const complete = Number.isInteger(r) && Number.isInteger(g) && Number.isInteger(b);
        // Out-of-range components clamp rather than drop the colour: tmux and
        // some TUIs emit them, and a slightly wrong hex beats no colour.
        state[code === 38 ? "fg" : "bg"] = complete ? toHex(r, g, b) : undefined;
        i += 4;
      } else {
        // Malformed extended colour: stop rather than guess.
        state[code === 38 ? "fg" : "bg"] = undefined;
        break;
      }
    }
    // Any other code (blink, overline, fraktur, ...) is ignored: the plugin
    // renderer has no equivalent, and Paseo's resolver ignores it too.
  }
}

/**
 * Consume the escape starting at `index`, mutating `state` for SGR.
 * Returns the index just past the escape. Never returns an index that would
 * re-emit escape bytes.
 */
function consumeEscape(line: string, index: number, state: SgrState, palette: AnsiPalette): number {
  const next = index + 1 < line.length ? line[index + 1] : undefined;

  if (next === "[") {
    let j = index + 2;
    while (j < line.length) {
      const code = line.charCodeAt(j);
      if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
        j += 1;
        continue;
      }
      break;
    }
    if (j >= line.length) return line.length; // truncated CSI: drop the tail
    if (line[j] === "m") applySgr(line.slice(index + 2, j), state, palette);
    return j + 1;
  }

  if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
    let j = index + 2;
    while (j < line.length) {
      if (line[j] === "\x07") return j + 1;
      if (line[j] === "\x1b" && line[j + 1] === "\\") return j + 2;
      j += 1;
    }
    return line.length;
  }

  if (next === undefined) return line.length;
  if (next === "(" || next === ")" || next === "*" || next === "+" || next === "#" || next === "%") {
    return Math.min(index + 3, line.length);
  }
  return index + 2;
}

function makeRun(text: string, state: SgrState): AnsiRun {
  const run: AnsiRun = { text };
  if (state.fg !== undefined) run.fg = state.fg;
  if (state.bg !== undefined) run.bg = state.bg;
  if (state.bold) run.bold = true;
  if (state.dim) run.dim = true;
  if (state.italic) run.italic = true;
  if (state.underline) run.underline = true;
  if (state.inverse) run.inverse = true;
  if (state.strike) run.strike = true;
  return run;
}

/**
 * Parse sanitized capture text into styled rows.
 *
 * SGR state carries across `\n` (a real terminal carries it; tmux re-emits it
 * per line, so carrying is the safe direction) and resets at the start of every
 * call. `inverse` is left as a flag for the caller to resolve — see
 * {@link resolveInverse}. Malformed sequences degrade to plain text; the parser
 * never throws and never puts an escape byte into `run.text`.
 */
export function parseAnsi(text: string, palette: AnsiPalette): AnsiLine[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const pal = isUsablePalette(palette) ? palette : buildTerminalPalette();

  const lines = text.split("\n");
  // A capture ends with a newline; that trailing "" is not a row of the pane.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const state: SgrState = {};
  const result: AnsiLine[] = [];

  for (const line of lines) {
    const runs: AnsiRun[] = [];
    let buffer = "";
    let plain = "";

    const flush = (): void => {
      if (buffer.length === 0) return;
      runs.push(makeRun(buffer, state));
      buffer = "";
    };

    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "\x1b") {
        flush();
        i = consumeEscape(line, i, state, pal);
        continue;
      }
      buffer += ch;
      plain += ch;
      i += 1;
    }
    flush();

    result.push({ runs, plain });
  }

  return result;
}

/**
 * Swap fg/bg for an inverted run and clear the flag, mirroring
 * `resolveCellColors` in colors.ts:130-135 (`inverse ? background : foreground`),
 * including the fallback to the palette defaults when one side is unset.
 * Returns a copy with `inverse` removed; the input is never mutated.
 */
export function resolveInverse(run: AnsiRun, palette: AnsiPalette): AnsiRun {
  if (!run || typeof run !== "object") return { text: "" };
  const copy: AnsiRun = { text: run.text };
  if (run.bold) copy.bold = true;
  if (run.dim) copy.dim = true;
  if (run.italic) copy.italic = true;
  if (run.underline) copy.underline = true;
  if (run.strike) copy.strike = true;

  if (!run.inverse) {
    if (run.fg !== undefined) copy.fg = run.fg;
    if (run.bg !== undefined) copy.bg = run.bg;
    return copy;
  }

  const pal = isUsablePalette(palette) ? palette : buildTerminalPalette();
  copy.fg = run.bg ?? pal.defaultBg;
  copy.bg = run.fg ?? pal.defaultFg;
  return copy;
}

/** Strip styling again: one string per row, joined with newlines. */
export function ansiLinesToPlain(lines: AnsiLine[]): string {
  if (!Array.isArray(lines)) return "";
  return lines.map((line) => (line && Array.isArray(line.runs) ? line.runs.map((run) => run.text).join("") : "")).join("\n");
}
