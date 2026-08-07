import { Fragment, type ReactNode } from "react";

/**
 * The answer subset of markdown, hand-rolled: fenced code, headings, lists, quotes and
 * paragraphs; inline code, bold, italic and links. A grammar this small does not earn a
 * dependency, and owning it means streamed half-finished input degrades predictably —
 * an unterminated fence renders as code instead of leaking backticks into prose.
 */

type Block =
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "heading"; depth: number; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[][] }
  | { kind: "para"; lines: string[] };

function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1; // the closing fence, or one past EOF mid-stream — both fine
      out.push({ kind: "code", lang: fence[1], lines: body });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)/.exec(line);
    if (heading) {
      out.push({ kind: "heading", depth: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", lines: body });
      continue;
    }

    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[][] = [];
      while (i < lines.length) {
        if (bullet.test(lines[i])) {
          // An indented bullet is the current item's sub-point, not a new list — treating
          // it as one split every "1. … - detail … 2. …" into lists that renumbered.
          const indented = /^\s{2,}/.test(lines[i]);
          if (indented && items.length) {
            items[items.length - 1].push(`• ${lines[i].replace(bullet, "")}`);
          } else {
            items.push([lines[i].replace(bullet, "")]);
          }
          i += 1;
          // Indented continuations belong to the item above them — but never a fence:
          // models indent code blocks inside list items, and swallowing the fence line
          // turned the whole block into one giant inline-code span.
          while (
            i < lines.length &&
            /^\s{2,}\S/.test(lines[i]) &&
            !bullet.test(lines[i]) &&
            !/^\s*```/.test(lines[i])
          ) {
            items[items.length - 1].push(lines[i].trim());
            i += 1;
          }
        } else break;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !bullet.test(lines[i]) &&
      !/^\s*>/.test(lines[i])
    ) {
      body.push(lines[i++]);
    }
    out.push({ kind: "para", lines: body });
  }

  return out;
}

/** Inline: `code` wins over everything (its content is verbatim), then **bold**, *italic*,
 * [text](url). One pass, splitting on the earliest match — no recursion needed for this set. */
function inline(text: string, key = 0): ReactNode {
  const m = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index);
  const rest = () => inline(text.slice(m.index + m[0].length), key + 1);
  if (m[1]) {
    return (
      <Fragment key={key}>
        {before}
        <code className="sw-md-code">{m[1].slice(1, -1)}</code>
        {rest()}
      </Fragment>
    );
  }
  if (m[2]) {
    return (
      <Fragment key={key}>
        {before}
        <strong>{inline(m[2].slice(2, -2))}</strong>
        {rest()}
      </Fragment>
    );
  }
  if (m[3]) {
    return (
      <Fragment key={key}>
        {before}
        <em>{inline(m[3].slice(1, -1))}</em>
      {rest()}
      </Fragment>
    );
  }
  const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(m[4])!;
  // Answers may cite paths that look like links; only http(s) becomes an anchor.
  const isHttp = /^https?:\/\//.test(link[2]);
  return (
    <Fragment key={key}>
      {before}
      {isHttp ? (
        <a href={link[2]} target="_blank" rel="noreferrer" className="sw-md-link">
          {inline(link[1])}
        </a>
      ) : (
        <code className="sw-md-code">{link[1]}</code>
      )}
      {rest()}
    </Fragment>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="sw-md">
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case "code":
            return (
              <pre key={i} className="sw-md-pre">
                <code>{b.lines.join("\n") || " "}</code>
              </pre>
            );
          case "heading":
            return b.depth <= 2 ? (
              <h3 key={i} className="sw-md-h">{inline(b.text)}</h3>
            ) : (
              <h4 key={i} className="sw-md-h sw-md-h-minor">{inline(b.text)}</h4>
            );
          case "quote":
            return (
              <blockquote key={i} className="sw-md-quote">
                {b.lines.map((l, j) => (
                  <p key={j}>{inline(l)}</p>
                ))}
              </blockquote>
            );
          case "list": {
            // The first line is the item; later lines (sub-bullets, wrapped detail) stack
            // beneath it inside the same <li>, so ordered lists never renumber mid-thought.
            const item = (lines: string[], j: number) => (
              <li key={j}>
                {inline(lines[0])}
                {lines.slice(1).map((ln, k) => (
                  <span key={k} className="sw-md-sub">
                    {inline(ln)}
                  </span>
                ))}
              </li>
            );
            return b.ordered ? (
              <ol key={i} className="sw-md-list sw-md-ol">
                {b.items.map(item)}
              </ol>
            ) : (
              <ul key={i} className="sw-md-list">
                {b.items.map(item)}
              </ul>
            );
          }
          default:
            return <p key={i}>{inline(b.lines.join(" "))}</p>;
        }
      })}
    </div>
  );
}
