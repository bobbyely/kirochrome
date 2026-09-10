import { memo } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

/** Hoisted so the plugin arrays are not fresh objects on every render. */
const REMARK = [remarkGfm];
const REHYPE = [rehypeHighlight];

/**
 * Renders agent output as markdown.
 *
 * `react-markdown` builds React elements rather than setting innerHTML, so
 * model output cannot inject HTML or script. That safety-by-construction is
 * why it is preferred here over a smaller renderer plus a sanitiser.
 *
 * highlight.js's common language set is ~150KB gzipped and rehype-highlight
 * bundles it whether or not we narrow the language list. Accepted: this is
 * served from localhost, so it is not a page-weight problem worth solving.
 *
 * Memoized because the parse and the highlight are the most expensive thing the
 * transcript does, and the text usually has not changed — only something else
 * on the page has.
 */
export const MarkdownBody = memo(function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>
        {children}
      </Markdown>
    </div>
  );
});
