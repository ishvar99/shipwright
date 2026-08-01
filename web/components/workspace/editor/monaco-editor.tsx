"use client";

import { useEffect, useMemo, useRef } from "react";
import Editor, { loader, type Monaco, type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { EDITOR_OPTIONS, SW_DARK, SW_LIGHT } from "@/components/workspace/editor/themes";

// Served from our own origin: the CSP has no CDN, and the loader's default is jsDelivr.
loader.config({ paths: { vs: "/monaco/vs" } });

export type EditorHandle = {
  reveal: (line: number, name?: string) => void;
  focus: () => void;
};

const LANGUAGES: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  toml: "ini",
  cfg: "ini",
  sql: "sql",
};

export function languageFor(path: string): string {
  return LANGUAGES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}

/** Monaco keeps models in a global registry, so every file ever opened stays in memory until
 * something disposes it. Closing a tab is the one moment that means "this buffer is gone". */
export function disposeModel(repoId: string, path: string): void {
  const monaco = (globalThis as { monaco?: typeof import("monaco-editor") }).monaco;
  monaco?.editor.getModel(monaco.Uri.parse(`file:///${repoId}/${path}`))?.dispose();
}

export function CodeEditor({
  repoId,
  path,
  value,
  readOnly,
  onChange,
  onCursor,
  handleRef,
}: {
  repoId: string;
  path: string;
  value: string;
  readOnly: boolean;
  onChange: (next: string) => void;
  onCursor?: (line: number, column: number) => void;
  handleRef?: (handle: EditorHandle | null) => void;
}) {
  const { resolvedTheme } = useTheme();
  // A fresh object each render makes the wrapper call updateOptions on every keystroke.
  const options = useMemo(() => ({ ...EDITOR_OPTIONS, readOnly }), [readOnly]);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorations = useRef<string[]>([]);

  // Themes must exist before the editor is created: monaco silently falls back to its
  // built-in light theme for an unknown id, which flashes white in dark mode.
  const beforeMount = (monaco: Monaco) => {
    monaco.editor.defineTheme("sw-light", SW_LIGHT);
    monaco.editor.defineTheme("sw-dark", SW_DARK);
  };

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.onDidChangeCursorPosition((e) => onCursor?.(e.position.lineNumber, e.position.column));

    handleRef?.({
      focus: () => editor.focus(),
      reveal: (line, name) => {
        const model = editor.getModel();
        if (!model) return;
        // The line was computed before any fix was applied, so treat it as a hint: clamp it,
        // and if the symbol name is nearby prefer where the name actually is now.
        let target = Math.min(Math.max(1, line), model.getLineCount());
        if (name) {
          const found = model.findMatches(name, true, false, true, null, false, 1);
          const near = found.find((m) => Math.abs(m.range.startLineNumber - target) <= 40);
          if (near) target = near.range.startLineNumber;
        }
        editor.revealLineInCenter(target);
        editor.setPosition({ lineNumber: target, column: 1 });
        decorations.current = editor.deltaDecorations(decorations.current, [
          {
            range: new monaco.Range(target, 1, target, 1),
            options: { isWholeLine: true, className: "sw-editor-target" },
          },
        ]);
      },
    });
  };

  useEffect(() => {
    monacoRef.current?.editor.setTheme(resolvedTheme === "dark" ? "sw-dark" : "sw-light");
  }, [resolvedTheme]);

  useEffect(() => () => handleRef?.(null), [handleRef]);

  return (
    <Editor
      // Namespaced by repo: two repos can hold the same path, and Monaco keys models by URI.
      path={`${repoId}/${path}`}
      language={languageFor(path)}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      beforeMount={beforeMount}
      onMount={onMount}
      options={options}
      loading={<div className="p-4 text-subtle">Loading the editor…</div>}
      theme={resolvedTheme === "dark" ? "sw-dark" : "sw-light"}
    />
  );
}
