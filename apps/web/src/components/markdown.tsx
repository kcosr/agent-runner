import {
  Children,
  type ReactNode,
  isValidElement,
  memo,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MermaidApi = typeof import("mermaid").default;

const MERMAID_ERROR_MESSAGE = "Failed to render Mermaid diagram.";
const MERMAID_LANGUAGE_CLASS = "language-mermaid";
const MERMAID_CONFIG = {
  securityLevel: "strict",
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: "neutral",
} as const;

let mermaidApiPromise: Promise<MermaidApi> | null = null;

function loadMermaidApi(): Promise<MermaidApi> {
  if (!mermaidApiPromise) {
    mermaidApiPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    });
  }
  return mermaidApiPromise;
}

function normalizeMermaidCode(value: ReactNode): string {
  return Children.toArray(value).join("").replace(/\n$/, "");
}

function readMermaidBlock(children: ReactNode): string | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }
  const [child] = childNodes;
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) {
    return null;
  }
  const className = child.props.className ?? "";
  const classes = className.split(/\s+/).filter(Boolean);
  if (!classes.includes(MERMAID_LANGUAGE_CLASS)) {
    return null;
  }
  return normalizeMermaidCode(child.props.children);
}

function MermaidDiagram({ code }: { code: string }) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; svg: string } | { status: "error"; message: string }
  >({ status: "loading" });
  const instanceId = useId().replace(/:/g, "-");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setState({ status: "loading" });
      try {
        const mermaid = await loadMermaidApi();
        const { svg } = await mermaid.render(`mermaid-${instanceId}`, code);
        if (!cancelled) {
          setState({ status: "ready", svg });
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : MERMAID_ERROR_MESSAGE;
        if (!cancelled) {
          setState({ status: "error", message });
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, instanceId]);

  useEffect(() => {
    if (state.status !== "ready" || !containerRef.current) {
      return;
    }
    const documentParser = new DOMParser();
    const parsedSvg = documentParser.parseFromString(state.svg, "image/svg+xml").documentElement;
    if (parsedSvg.nodeName === "parsererror") {
      setState({ status: "error", message: MERMAID_ERROR_MESSAGE });
      return;
    }
    containerRef.current.replaceChildren(document.importNode(parsedSvg, true));
    return () => {
      containerRef.current?.replaceChildren();
    };
  }, [state]);

  if (state.status === "error") {
    return (
      <div aria-label="Mermaid diagram error" className="markdown-mermaid markdown-mermaid--error">
        <p className="markdown-mermaid__error-title">Mermaid diagram failed to render</p>
        <p className="markdown-mermaid__error-message">{state.message}</p>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div
        aria-label="Mermaid diagram loading"
        className="markdown-mermaid markdown-mermaid--loading"
      >
        Rendering Mermaid diagram...
      </div>
    );
  }

  return <div aria-label="Mermaid diagram" className="markdown-mermaid" ref={containerRef} />;
}

const components: Components = {
  a({ node: _node, href, ...props }) {
    return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
  },
  pre({ node: _node, children, ...props }) {
    const mermaidCode = readMermaidBlock(children);
    if (mermaidCode !== null) {
      return <MermaidDiagram code={mermaidCode} />;
    }
    return <pre {...props}>{children}</pre>;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="markdown-table-wrap">
        <table {...props} />
      </div>
    );
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
