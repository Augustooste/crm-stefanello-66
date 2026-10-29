import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";

import { useTenantProfiles } from "@/lib/api/session";
import { useBoards } from "@/lib/api/boards";
import { DashboardFilters, dashboardPeriodRange } from "./dashboard-filters";

vi.mock("@/lib/api/session", () => ({ useTenantProfiles: vi.fn() }));
vi.mock("@/lib/api/boards", () => ({ useBoards: vi.fn() }));

const profilesMock = vi.mocked(useTenantProfiles);
const boardsMock = vi.mocked(useBoards);

function renderFilters(overrides: Partial<ComponentProps<typeof DashboardFilters>> = {}) {
  const onPeriodChange = vi.fn();
  const onOwnerChange = vi.fn();
  const onBoardChange = vi.fn();
  render(
    <DashboardFilters
      period="7"
      onPeriodChange={onPeriodChange}
      ownerId={null}
      onOwnerChange={onOwnerChange}
      boardId={null}
      onBoardChange={onBoardChange}
      {...overrides}
    />,
  );
  return { onPeriodChange, onOwnerChange, onBoardChange };
}

describe("dashboardPeriodRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 14, 30, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("'today' -- from é meia-noite de hoje, to é agora", () => {
    const { from, to } = dashboardPeriodRange("today");
    expect(from.getDate()).toBe(15);
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(to.getHours()).toBe(14);
  });

  it("'7' -- from é 7 dias atrás, mesma hora", () => {
    const { from } = dashboardPeriodRange("7");
    expect(from.getDate()).toBe(8);
    expect(from.getMonth()).toBe(6);
    expect(from.getHours()).toBe(14);
  });

  it("'30' -- from é 30 dias atrás, cruzando o mês", () => {
    const { from } = dashboardPeriodRange("30");
    expect(from.getMonth()).toBe(5);
    expect(from.getDate()).toBe(15);
  });

  it("'month' -- from é dia 1 do mês corrente, meia-noite", () => {
    const { from } = dashboardPeriodRange("month");
    expect(from.getDate()).toBe(1);
    expect(from.getHours()).toBe(0);
    expect(from.getMonth()).toBe(6);
  });
});

describe("DashboardFilters", () => {
  beforeEach(() => {
    profilesMock.mockReturnValue({ data: [] } as never);
    boardsMock.mockReturnValue({ data: [] } as never);
  });

  it("mostra o rótulo do período selecionado", () => {
    renderFilters({ period: "30" });
    expect(screen.getByText("Últimos 30 dias")).toBeInTheDocument();
  });

  it("não quebra quando useTenantProfiles/useBoards ainda não retornaram dados (undefined)", () => {
    profilesMock.mockReturnValue({ data: undefined } as never);
    boardsMock.mockReturnValue({ data: undefined } as never);

    renderFilters();

    expect(screen.getByText("Todos os responsáveis")).toBeInTheDocument();
    // Sem quadros carregados ainda, o seletor de quadro fica escondido.
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("lista responsáveis do tenant no seletor de dono, com opção 'Todos'", async () => {
    const user = userEvent.setup();
    profilesMock.mockReturnValue({
      data: [
        { id: "p1", name: "Ana", role: "admin" },
        { id: "p2", name: "Beto", role: "agent" },
      ],
    } as never);
    renderFilters();
    expect(screen.getByText("Todos os responsáveis")).toBeInTheDocument();

    const comboboxes = screen.getAllByRole("combobox");
    await user.click(comboboxes[1]);
    expect(await screen.findByRole("option", { name: "Ana" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Beto" })).toBeInTheDocument();
  });

  it("não mostra o seletor de quadro com 0 ou 1 quadro no tenant", () => {
    boardsMock.mockReturnValue({
      data: [{ id: "b1", name: "Vendas", is_default: true, position: 0 }],
    } as never);
    renderFilters();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("mostra o seletor de quadro com 2+ quadros, com sufixo '(padrão)' no quadro default", async () => {
    const user = userEvent.setup();
    boardsMock.mockReturnValue({
      data: [
        { id: "b1", name: "Vendas", is_default: true, position: 0 },
        { id: "b2", name: "Suporte", is_default: false, position: 1 },
      ],
    } as never);
    renderFilters();

    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(3);

    await user.click(comboboxes[2]);
    expect(await screen.findByRole("option", { name: "Vendas (padrão)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Suporte" })).toBeInTheDocument();
  });

  it("chama onOwnerChange com o id ao selecionar um responsável específico", async () => {
    const user = userEvent.setup();
    profilesMock.mockReturnValue({
      data: [{ id: "p1", name: "Ana", role: "admin" }],
    } as never);
    const { onOwnerChange } = renderFilters();

    const comboboxes = screen.getAllByRole("combobox");
    await user.click(comboboxes[1]);
    await user.click(await screen.findByRole("option", { name: "Ana" }));

    expect(onOwnerChange).toHaveBeenCalledWith("p1");
  });

  it("chama onOwnerChange(null) ao voltar para 'Todos os responsáveis'", async () => {
    const user = userEvent.setup();
    profilesMock.mockReturnValue({
      data: [{ id: "p1", name: "Ana", role: "admin" }],
    } as never);
    const { onOwnerChange } = renderFilters({ ownerId: "p1" });

    const comboboxes = screen.getAllByRole("combobox");
    await user.click(comboboxes[1]);
    await user.click(await screen.findByRole("option", { name: "Todos os responsáveis" }));

    expect(onOwnerChange).toHaveBeenCalledWith(null);
  });

  it("chama onBoardChange com o id ao selecionar um quadro específico", async () => {
    const user = userEvent.setup();
    boardsMock.mockReturnValue({
      data: [
        { id: "b1", name: "Vendas", is_default: true, position: 0 },
        { id: "b2", name: "Suporte", is_default: false, position: 1 },
      ],
    } as never);
    const { onBoardChange } = renderFilters();

    const comboboxes = screen.getAllByRole("combobox");
    await user.click(comboboxes[2]);
    await user.click(await screen.findByRole("option", { name: "Suporte" }));

    expect(onBoardChange).toHaveBeenCalledWith("b2");
  });

  it("chama onBoardChange(null) ao selecionar 'Todos os quadros'", async () => {
    const user = userEvent.setup();
    boardsMock.mockReturnValue({
      data: [
        { id: "b1", name: "Vendas", is_default: true, position: 0 },
        { id: "b2", name: "Suporte", is_default: false, position: 1 },
      ],
    } as never);
    const { onBoardChange } = renderFilters({ boardId: "b1" });

    const comboboxes = screen.getAllByRole("combobox");
    await user.click(comboboxes[2]);
    await user.click(await screen.findByRole("option", { name: "Todos os quadros" }));

    expect(onBoardChange).toHaveBeenCalledWith(null);
  });

  it("chama onPeriodChange ao trocar o período", async () => {
    const user = userEvent.setup();
    const { onPeriodChange } = renderFilters({ period: "7" });

    const comboboxes = screen.getAllByRole("combobox");
    await user.click(comboboxes[0]);
    await user.click(await screen.findByRole("option", { name: "Este mês" }));

    expect(onPeriodChange).toHaveBeenCalledWith("month");
  });
});
