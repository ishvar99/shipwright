import type * as Monaco from "monaco-editor";

/**
 * Literal hex, not CSS variables: a Monaco theme is registered once as data and cannot read
 * `var(--token)`. Each value names the token it mirrors — the same accepted duplication as
 * the UI_PREFS_BOOT string. Keep in step with globals.css.
 */
const LIGHT = {
  bg: "#FBFAF9", // --surface
  fg: "#26262B", // --fg
  subtle: "#6B6B75", // --subtle
  line: "#EDEBE8", // --soft
  accentSoft: "#EAE7FA", // --accent-soft
  comment: "#8A8A94",
  keyword: "#6553D9", // --accent
  string: "#2F7A55", // --ok
  number: "#B4571F", // --warn
};

const DARK = {
  bg: "#111118", // --surface
  fg: "#EDEDF0", // --fg
  subtle: "#858592", // --subtle
  line: "#1A1A22", // --soft
  accentSoft: "#221C3D", // --accent-soft
  comment: "#6E6E7A",
  keyword: "#8B7CF6", // --accent
  string: "#5FBE8B", // --ok
  number: "#E0A567", // --warn
};

function theme(c: typeof LIGHT, base: "vs" | "vs-dark"): Monaco.editor.IStandaloneThemeData {
  return {
    base,
    inherit: true,
    rules: [
      { token: "comment", foreground: c.comment.slice(1), fontStyle: "italic" },
      { token: "keyword", foreground: c.keyword.slice(1) },
      { token: "string", foreground: c.string.slice(1) },
      { token: "number", foreground: c.number.slice(1) },
      { token: "type", foreground: c.keyword.slice(1) },
    ],
    colors: {
      "editor.background": c.bg,
      "editor.foreground": c.fg,
      "editorLineNumber.foreground": c.subtle,
      "editorLineNumber.activeForeground": c.fg,
      "editor.lineHighlightBackground": c.line,
      "editor.selectionBackground": c.accentSoft,
      "editorIndentGuide.background1": c.line,
      "editorWidget.background": c.bg,
      "editorWidget.border": c.line,
      "editorGutter.background": c.bg,
      "scrollbarSlider.background": `${c.line}CC`,
      "scrollbarSlider.hoverBackground": c.subtle,
    },
  };
}

export const SW_LIGHT = theme(LIGHT, "vs");
export const SW_DARK = theme(DARK, "vs-dark");

/** Quieter than Monaco's defaults, which are far louder than the rest of this product. */
export const EDITOR_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "line",
  lineNumbersMinChars: 3,
  folding: true,
  fontSize: 13,
  lineHeight: 20,
  fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
  smoothScrolling: true,
  cursorBlinking: "smooth",
  padding: { top: 12, bottom: 12 },
  automaticLayout: true,
  tabSize: 4,
};
