import {
  Children,
  type HTMLAttributes,
  type ReactNode,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { writeToClipboard } from "../lib/clipboard.js";
import { CheckIcon, CopyIcon } from "./icons.js";

type MermaidApi = typeof import("mermaid").default;

const MERMAID_ERROR_MESSAGE = "Failed to render Mermaid diagram.";
const MERMAID_LANGUAGE_CLASS = "language-mermaid";
const MERMAID_CONFIG = {
  securityLevel: "strict",
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: "neutral",
} as const;
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const COPY_STATUS_RESET_MS = 1800;
const TOUCH_COPY_BUTTON_QUERY = "(hover: none), (pointer: coarse), (max-width: 720px)";

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

function normalizeReactNodeText(value: ReactNode): string {
  return Children.toArray(value)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return normalizeReactNodeText(child.props.children);
      }
      return "";
    })
    .join("")
    .replace(/\n$/, "");
}

function codeFenceFor(code: string): string {
  const longestBacktickRun = (code.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function renderLeadingFrontmatterAsCodeBlock(text: string): string {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    return text;
  }
  const yaml = match[1] ?? "";
  const body = text.slice(match[0].length).replace(/^\r?\n/, "");
  const fence = codeFenceFor(yaml);
  const frontmatterBlock = `${fence}yaml\n${yaml}\n${fence}`;
  return body.length > 0 ? `${frontmatterBlock}\n\n${body}` : frontmatterBlock;
}

function shouldResetCopyStatusOnTimer(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return true;
  }
  return window.matchMedia(TOUCH_COPY_BUTTON_QUERY).matches;
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
  return normalizeReactNodeText(child.props.children);
}

function MermaidDiagram({ code }: { code: string }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        svg: string;
        bindFunctions?: (element: Element) => void;
      }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const instanceId = useId().replace(/:/g, "-");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setState({ status: "loading" });
      try {
        const mermaid = await loadMermaidApi();
        const { bindFunctions, svg } = await mermaid.render(`mermaid-${instanceId}`, code);
        if (!cancelled) {
          setState({ status: "ready", svg, bindFunctions });
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
    try {
      containerRef.current.replaceChildren(document.importNode(parsedSvg, true));
      state.bindFunctions?.(containerRef.current);
    } catch (error) {
      containerRef.current.replaceChildren();
      const message =
        error instanceof Error && error.message.length > 0 ? error.message : MERMAID_ERROR_MESSAGE;
      setState({ status: "error", message });
      return;
    }
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

function CodeBlock({
  children,
  preProps,
}: {
  children: ReactNode;
  preProps: HTMLAttributes<HTMLPreElement>;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const isMountedRef = useRef(true);
  const resetTimeoutRef = useRef<number | null>(null);
  const codeText = normalizeReactNodeText(children);
  const copyLabel =
    copyStatus === "copied"
      ? "Copied code block"
      : copyStatus === "failed"
        ? "Failed to copy code block"
        : "Copy code block";

  const clearResetTimeout = useCallback(() => {
    if (resetTimeoutRef.current === null || typeof window === "undefined") {
      return;
    }
    window.clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = null;
  }, []);

  const scheduleStatusReset = useCallback(() => {
    clearResetTimeout();
    if (typeof window === "undefined") {
      return;
    }
    resetTimeoutRef.current = window.setTimeout(() => {
      setCopyStatus("idle");
      resetTimeoutRef.current = null;
    }, COPY_STATUS_RESET_MS);
  }, [clearResetTimeout]);

  const resetCopyStatus = useCallback(() => {
    clearResetTimeout();
    setCopyStatus("idle");
  }, [clearResetTimeout]);

  async function handleCopy() {
    let copied = false;
    try {
      copied = await writeToClipboard(codeText);
    } catch {
      copied = false;
    }
    if (!isMountedRef.current) {
      return;
    }
    setCopyStatus(copied ? "copied" : "failed");
    if (!copied || shouldResetCopyStatusOnTimer()) {
      scheduleStatusReset();
    }
  }

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearResetTimeout();
    };
  }, [clearResetTimeout]);

  return (
    <div
      className="markdown-code-block"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        resetCopyStatus();
      }}
      onPointerLeave={resetCopyStatus}
    >
      <pre {...preProps}>{children}</pre>
      <button
        aria-label={copyLabel}
        className={`markdown-code-block__copy copy${
          copyStatus === "copied" ? " markdown-code-block__copy--copied" : ""
        }`}
        onClick={() => void handleCopy()}
        title={copyLabel}
        type="button"
      >
        {copyStatus === "copied" ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
      </button>
    </div>
  );
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
    return <CodeBlock preProps={props}>{children}</CodeBlock>;
  },
  table({ node: _node, ...props }) {
    return (
      <div className="markdown-table-wrap">
        <table {...props} />
      </div>
    );
  },
};

function MarkdownContentInner({
  text,
  className,
  renderFrontmatterAsCodeBlock = false,
}: {
  text: string;
  className?: string;
  renderFrontmatterAsCodeBlock?: boolean;
}) {
  const renderedText = renderFrontmatterAsCodeBlock
    ? renderLeadingFrontmatterAsCodeBlock(text)
    : text;

  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {renderedText}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentInner);
