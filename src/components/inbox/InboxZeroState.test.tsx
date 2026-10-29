import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxZeroState } from "./InboxZeroState";

describe("InboxZeroState", () => {
  it("sem conversas ocultas afirma 'Tudo em dia!'", () => {
    render(<InboxZeroState />);
    expect(screen.getByText("Tudo em dia!")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ampliar período" })).toBeNull();
  });

  it("com conversas ocultas pelo período não afirma 'Tudo em dia!' e amplia ao clicar", async () => {
    const onWidenPeriod = vi.fn();
    render(
      <InboxZeroState
        hiddenByPeriod={13}
        periodLabel="Últimos 30 dias"
        onWidenPeriod={onWidenPeriod}
      />,
    );
    expect(screen.queryByText("Tudo em dia!")).toBeNull();
    expect(screen.getByText(/13 conversas abertas mais antigas/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Ampliar período" }));
    expect(onWidenPeriod).toHaveBeenCalledTimes(1);
  });
});
