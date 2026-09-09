import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

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
 */
export function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </Markdown>
    </div>
  );
}
