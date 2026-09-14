import hljs from "highlight.js/lib/common";
import { collapseContext, countChanges, lineDiff } from "./diff.js";
import { MarkdownBody } from "./Markdown.js";
import { languageFor, type ToolDiff } from "./timeline.js";

/**
 * One line of a diff, highlighted on its own.
 *
 * Line by line rather than the whole file, because a diff interleaves two
 * files: the tokens are right for anything that fits on a line and only drift
 * inside a multi-line string or comment, which is the trade GitHub makes too.
 * highlight.js escapes the text itself, so the markup it returns is safe to set.
 */
function highlightLine(text: string, language: string): string {
  if (!language || !hljs.getLanguage(language)) return escapeHtml(text);
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A file edit, rendered as a diff rather than two blobs of JSON. */
export function DiffView({ diff }: { diff: ToolDiff }) {
  const lines = lineDiff(diff.oldText, diff.newText);
  if (!lines) {
    // Too large for the quadratic LCS; show the result rather than nothing.
    return (
      <div className="diff">
        <div className="diff-head">{diff.path} <span className="muted">(too large to diff)</span></div>
        <CodeBlock text={diff.newText} language={languageFor(diff.path)} />
      </div>
    );
  }

  const rows = collapseContext(lines);
  const { added, removed } = countChanges(lines);
  const language = languageFor(diff.path);
  return (
    <div className="diff">
      <div className="diff-head">
        <code>{diff.path}</code>
        <span className="diff-stat">+{added} −{removed}</span>
      </div>
      <pre className="diff-body">
        {rows.map((row, i) =>
          row.kind === "gap" ? (
            <span key={i} className="diff-gap">{`⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"}\n`}</span>
          ) : (
            <span key={i} className={`diff-line diff-${row.kind}`}>
              {`${row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "} `}
              <span dangerouslySetInnerHTML={{ __html: highlightLine(row.text, language) }} />
              {"\n"}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}

/** Tool text output, highlighted when we can guess the language. */
export function CodeBlock({ text, language }: { text: string; language: string }) {
  return <MarkdownBody>{`\`\`\`${language}\n${text}\n\`\`\``}</MarkdownBody>;
}
