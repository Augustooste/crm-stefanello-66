import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InboxOverviewView, type InboxOverviewViewProps } from "./InboxOverviewView";

const COLD_DEAL = {
  id: "deal-1",
  title: "Negócio Acme",
  contactName: "João",
  contactId: "contact-1",
};
const COLD_CONVERSATION = { id: "conv-1", contactName: "Maria", contactId: "contact-2" };
const HOT_LEAD = { contactId: "contact-3", contactName: "Pedro", rationale: "Respondeu rápido" };

function setup(overrides: Partial<InboxOverviewViewProps> = {}) {
  const onOpenFilter = vi.fn();
  const onOpenDeal = vi.fn();
  const onOpenConversation = vi.fn();
  const onOpenContact = vi.fn();
  const onStartFocus = vi.fn();
  const onApplyDeal = vi.fn();
  const onApplyConversation = vi.fn();
  const onApplyOpportunity = vi.fn();

  render(
    <InboxOverviewView
      overdueCount={0}
      todayCount={0}
      pendingCount={0}
      onOpenFilter={onOpenFilter}
      coldDeals={[COLD_DEAL]}
      coldConversations={[COLD_CONVERSATION]}
      onOpenDeal={onOpenDeal}
      onOpenConversation={onOpenConversation}
      hotLeads={[HOT_LEAD]}
      onOpenContact={onOpenContact}
      focusQueueEmpty={false}
      onStartFocus={onStartFocus}
      onApplyDeal={onApplyDeal}
      onApplyConversation={onApplyConversation}
      onApplyOpportunity={onApplyOpportunity}
      applyingKeys={new Set()}
      {...overrides}
    />,
  );

  return {
    onOpenFilter,
    onOpenDeal,
    onOpenConversation,
    onOpenContact,
    onStartFocus,
    onApplyDeal,
    onApplyConversation,
    onApplyOpportunity,
  };
}

describe("InboxOverviewView — ação inline Aplicar", () => {
  it("clicar em Aplicar no deal frio chama onApplyDeal com dealId + contactId, sem navegar", async () => {
    const { onApplyDeal, onOpenDeal } = setup();
    const user = userEvent.setup();

    const row = screen.getByText("Negócio Acme").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Aplicar" }));

    expect(onApplyDeal).toHaveBeenCalledWith("deal-1", "contact-1");
    expect(onOpenDeal).not.toHaveBeenCalled();
    // O botão de navegação original ("Resgatar") continua disponível como ação secundária.
    expect(within(row).getByRole("button", { name: "Resgatar" })).toBeInTheDocument();
  });

  it("deal frio sem contactId não mostra o botão Aplicar, só a navegação", () => {
    setup({ coldDeals: [{ ...COLD_DEAL, contactId: null }] });

    const row = screen.getByText("Negócio Acme").closest("li") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Aplicar" })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Resgatar" })).toBeInTheDocument();
  });

  it("clicar em Aplicar na conversa fria chama onApplyConversation com conversationId + contactId", async () => {
    const { onApplyConversation, onOpenConversation } = setup();
    const user = userEvent.setup();

    const row = screen.getByText("Maria").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Aplicar" }));

    expect(onApplyConversation).toHaveBeenCalledWith("conv-1", "contact-2");
    expect(onOpenConversation).not.toHaveBeenCalled();
    expect(within(row).getByRole("button", { name: "Abrir" })).toBeInTheDocument();
  });

  it("clicar em Aplicar na oportunidade quente chama onApplyOpportunity com contactId", async () => {
    const { onApplyOpportunity, onOpenContact } = setup();
    const user = userEvent.setup();

    const row = screen.getByText("Pedro").closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Aplicar" }));

    expect(onApplyOpportunity).toHaveBeenCalledWith("contact-3");
    expect(onOpenContact).not.toHaveBeenCalled();
  });

  it("mostra 'Aplicando…' e desabilita só a linha cuja key está no Set applyingKeys", () => {
    setup({ applyingKeys: new Set(["deal-deal-1"]) });

    const dealRow = screen.getByText("Negócio Acme").closest("li") as HTMLElement;
    const convRow = screen.getByText("Maria").closest("li") as HTMLElement;

    expect(within(dealRow).getByRole("button", { name: "Aplicando…" })).toBeDisabled();
    expect(within(convRow).getByRole("button", { name: "Aplicar" })).toBeEnabled();
  });

  it("duas keys simultâneas no Set desabilitam as duas linhas independentemente", () => {
    setup({ applyingKeys: new Set(["deal-deal-1", "conv-conv-1"]) });

    const dealRow = screen.getByText("Negócio Acme").closest("li") as HTMLElement;
    const convRow = screen.getByText("Maria").closest("li") as HTMLElement;
    const hotRow = screen.getByText("Pedro").closest("li") as HTMLElement;

    expect(within(dealRow).getByRole("button", { name: "Aplicando…" })).toBeDisabled();
    expect(within(convRow).getByRole("button", { name: "Aplicando…" })).toBeDisabled();
    expect(within(hotRow).getByRole("button", { name: "Aplicar" })).toBeEnabled();
  });
});
