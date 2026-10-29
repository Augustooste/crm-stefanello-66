import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InboxFocusView, type FocusQueueItem } from "./InboxFocusView";

const ITEM: FocusQueueItem = {
  id: "c1",
  awaiting_human: true,
  last_message_at: new Date().toISOString(),
  last_message: { content: "Oi, tudo bem?", sender: "contact" },
  contact: { name: "Ana Souza" },
  channel: { type: "whatsapp" },
};

function setup(overrides: Partial<Parameters<typeof InboxFocusView>[0]> = {}) {
  const onReply = vi.fn();
  const onSkip = vi.fn();
  const onResolve = vi.fn();
  const onExitFocus = vi.fn();
  render(
    <InboxFocusView
      currentItem={ITEM}
      currentIndex={0}
      totalItems={1}
      onReply={onReply}
      onSkip={onSkip}
      onResolve={onResolve}
      onExitFocus={onExitFocus}
      replyPending={false}
      {...overrides}
    />,
  );
  return { onReply, onSkip, onResolve, onExitFocus };
}

describe("InboxFocusView — atalhos de teclado", () => {
  it("P pula o item quando o foco não está no textarea", async () => {
    const { onSkip } = setup();
    const user = userEvent.setup();

    // A raiz do componente é focável (tabIndex=0) e recebe o keydown.
    const root = screen.getByText("Ana Souza").closest("[tabindex]") as HTMLElement;
    root.focus();
    await user.keyboard("p");

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("P dentro do textarea NÃO pula (evita conflito ao digitar a letra p na resposta)", async () => {
    const { onSkip } = setup();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Resposta rápida"), "p");

    expect(onSkip).not.toHaveBeenCalled();
  });

  it("Enter fora do textarea foca o textarea (não envia direto)", async () => {
    const { onReply } = setup();
    const user = userEvent.setup();

    const root = screen.getByText("Ana Souza").closest("[tabindex]") as HTMLElement;
    root.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Resposta rápida")).toHaveFocus();
    expect(onReply).not.toHaveBeenCalled();
  });

  it("Esc sai do Modo Foco via onExitFocus", async () => {
    const { onExitFocus } = setup();
    const user = userEvent.setup();

    const root = screen.getByText("Ana Souza").closest("[tabindex]") as HTMLElement;
    root.focus();
    await user.keyboard("{Escape}");

    expect(onExitFocus).toHaveBeenCalledTimes(1);
  });
});
