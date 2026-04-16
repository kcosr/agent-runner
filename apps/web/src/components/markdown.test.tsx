import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  it("renders mermaid fenced code blocks as diagrams", async () => {
    renderMermaid.mockResolvedValueOnce({
      svg: "<svg><text>diagram</text></svg>",
    });

    render(<MarkdownContent text={"```mermaid\ngraph TD\nA-->B\n```"} />);

    const diagram = await screen.findByLabelText("Mermaid diagram");
    await waitFor(() => expect(diagram.querySelector("svg")).not.toBeNull());
    expect(renderMermaid).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      "graph TD\nA-->B",
    );
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
});
