import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a({ node: _node, href, ...props }) {
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
  },
};

function MarkdownContentInner({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentInner);
