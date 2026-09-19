import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { store } from "../lib/store.ts";

/** A code span reads as a workspace path when it looks like one: slash-
 * separated, file extension, no spaces or scheme. Clicking it opens the file
 * in the session dock. */
function looksLikeWorkspacePath(text: string): boolean {
  return /^[\w@.][\w@./-]*\.[A-Za-z0-9]{1,8}$/.test(text) && text.includes("/") && !text.includes("..");
}

/** Render assistant/user text as GitHub-flavored markdown with code highlighting.
 * Workspace-path code spans deep-link into the dock's file tab. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          code(props) {
            const { className, children } = props;
            const raw = String(children ?? "").replace(/^\.\//, "");
            const match = /^([^#]+)(#L(\d+)(?:-L(\d+))?)?$/.exec(raw);
            if (!className && match && looksLikeWorkspacePath(match[1]!)) {
              const lineStart = match[3] !== undefined ? Number(match[3]) : undefined;
              const lineEnd = match[4] !== undefined ? Number(match[4]) : lineStart;
              return (
                <code
                  className="md-file-link"
                  title={lineStart !== undefined ? `在会话工作区中打开（跳到第 ${lineStart} 行）` : "在会话工作区中打开"}
                  onClick={() => store.getState().requestDockFile(match[1]!, lineStart, lineEnd)}
                >
                  {children}
                </code>
              );
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
