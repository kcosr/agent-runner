import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./markdown.js";

describe("MarkdownContent", () => {
  it("wraps tables in a dedicated horizontal scroll container", () => {
    const { container } = render(<MarkdownContent text={"| A | B |\n| - | - |\n| 1 | 2 |"} />);

    const table = screen.getByRole("table");
    const wrapper = container.querySelector(".markdown-table-wrap");

    expect(wrapper).not.toBeNull();
    expect(wrapper?.firstElementChild).toBe(table);
  });
});
