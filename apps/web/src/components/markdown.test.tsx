import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./markdown.js";

const initializeMermaid = vi.fn();
const renderMermaid = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMermaid,
    render: renderMermaid,
  },
}));

describe("MarkdownContent", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubClipboard(writeText?: (value: string) => Promise<void>) {
    const stubbedNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(stubbedNavigator, "clipboard", {
      configurable: true,
      value: writeText ? { writeText } : undefined,
    });
    vi.stubGlobal("navigator", stubbedNavigator);
  }

  function stubDocumentCopy(copy: () => boolean) {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(copy),
    });
  }

  it("renders mermaid fenced code blocks as diagrams", async () => {
    renderMermaid.mockResolvedValueOnce({
      svg: "<svg><text>diagram</text></svg>",
    });

    render(<MarkdownContent text={"```mermaid\ngraph TD\nA-->B\n```"} />);

    const diagram = await screen.findByLabelText("Mermaid diagram");
    await waitFor(() => expect(diagram.querySelector("svg")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Copy code block" })).not.toBeInTheDocument();
    expect(renderMermaid).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      "graph TD\nA-->B",
    );
  });

  it("binds mermaid interactions after the diagram mounts", async () => {
    const bindFunctions = vi.fn();
    renderMermaid.mockResolvedValueOnce({
      bindFunctions,
      svg: "<svg><text>diagram</text></svg>",
    });

    render(<MarkdownContent text={"```mermaid\ngraph TD\nA-->B\n```"} />);

    const diagram = await screen.findByLabelText("Mermaid diagram");
    await waitFor(() => expect(bindFunctions).toHaveBeenCalledWith(diagram));
  });

  it("shows an inline error when mermaid rendering fails", async () => {
    renderMermaid.mockRejectedValueOnce(new Error("Parse error"));

    render(<MarkdownContent text={"```mermaid\ngraph TD\nA-->B\n```"} />);

    expect(await screen.findByLabelText("Mermaid diagram error")).toBeInTheDocument();
    expect(screen.getByText("Mermaid diagram failed to render")).toBeInTheDocument();
    expect(screen.getByText("Parse error")).toBeInTheDocument();
  });

  it("wraps tables in a dedicated horizontal scroll container", () => {
    const { container } = render(<MarkdownContent text={"| A | B |\n| - | - |\n| 1 | 2 |"} />);

    const table = screen.getByRole("table");
    const wrapper = container.querySelector(".markdown-table-wrap");

    expect(wrapper).not.toBeNull();
    expect(wrapper?.firstElementChild).toBe(table);
  });

  it("renders leading frontmatter as a fenced YAML code block when requested", () => {
    const { container } = render(
      <MarkdownContent
        renderFrontmatterAsCodeBlock
        text={"---\ntitle: Notes\nsource: attachment\n---\n# Body"}
      />,
    );

    const frontmatterCode = container.querySelector("pre code");

    expect(frontmatterCode).not.toBeNull();
    expect(frontmatterCode?.textContent).toBe("title: Notes\nsource: attachment\n");
    expect(screen.getByRole("heading", { name: "Body" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "title: Notes" })).not.toBeInTheDocument();
  });

  it("copies non-Mermaid fenced code blocks", async () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<MarkdownContent text={'```ts\nconsole.log("copied");\n```'} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('console.log("copied");'));
    expect(await screen.findByRole("button", { name: "Copied code block" })).toBeInTheDocument();
  });

  it("shows copied feedback until the pointer leaves the code block", async () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: "(hover: none), (pointer: coarse), (max-width: 720px)",
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    );
    const { container } = render(<MarkdownContent text={"```sh\nprintf copied\n```"} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));

    const copiedButton = await screen.findByRole("button", { name: "Copied code block" });
    expect(copiedButton.querySelector("path")).toHaveAttribute("d", "M20 6 9 17l-5-5");
    fireEvent.pointerLeave(container.querySelector(".markdown-code-block") ?? copiedButton);

    expect(screen.getByRole("button", { name: "Copy code block" })).toBeInTheDocument();
  });

  it("reports code block copy failures", async () => {
    stubClipboard();
    stubDocumentCopy(() => false);

    render(<MarkdownContent text={"```sh\nexit 1\n```"} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));

    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith("copy"));
    expect(
      await screen.findByRole("button", { name: "Failed to copy code block" }),
    ).toBeInTheDocument();
  });

  it("resets code block copy feedback after a short delay", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<MarkdownContent text={"```sh\nprintf copied\n```"} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Copied code block" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1800);
    });

    expect(screen.getByRole("button", { name: "Copy code block" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("makes frontmatter code blocks copyable", async () => {
    const writeText = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(
      <MarkdownContent
        renderFrontmatterAsCodeBlock
        text={"---\ntitle: Notes\nsource: attachment\n---\n# Body"}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("title: Notes\nsource: attachment"));
  });
});
