import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AppointmentRow } from "@/lib/api/appointments";
import { WeeklyCalendar } from "./WeeklyCalendar";

function appt(overrides: Partial<AppointmentRow>): AppointmentRow {
  return {
    id: "apt-1",
    tenant_id: "t1",
    contact_id: null,
    title: "Compromisso",
    date: "2026-07-13",
    time_start: "10:00:00",
    time_end: null,
    modality: "presencial",
    status: "scheduled",
    notes: null,
    custom_fields: {},
    external_ref: null,
    external_source: null,
    created_by: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    contact: null,
    ...overrides,
  };
}

// 2026-07-13 é uma segunda-feira -- weekStart alinhado com DAYS[0] ("Seg").
const WEEK_START = new Date("2026-07-13T00:00:00");

describe("WeeklyCalendar", () => {
  it("renderiza um compromisso na hora cheia normalmente", () => {
    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[appt({ id: "a1", time_start: "10:00:00", title: "Consulta A" })]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );
    expect(screen.getByText("Consulta A")).toBeInTheDocument();
  });

  it("bucketiza um compromisso fora da hora cheia na linha da hora em que começa", () => {
    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[appt({ id: "a1", time_start: "14:30:00", title: "Sincronizado Feegow" })]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );
    // Visível (regressão do bug: só HH:00 exato aparecia antes) e com o
    // horário real exibido no chip, já que a linha é "14:00" mas o
    // compromisso é às 14:30.
    expect(screen.getByText("Sincronizado Feegow")).toBeInTheDocument();
    expect(screen.getByText("14:30")).toBeInTheDocument();
  });

  it("mostra 2 compromissos na mesma hora sem um sobrescrever o outro", () => {
    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[
          appt({ id: "a1", time_start: "09:00:00", title: "Primeiro" }),
          appt({ id: "a2", time_start: "09:45:00", title: "Segundo" }),
        ]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );
    expect(screen.getByText("Primeiro")).toBeInTheDocument();
    expect(screen.getByText("Segundo")).toBeInTheDocument();
  });

  it("mostra o rótulo e ícone de modalidade 'Online' para compromissos não-presenciais", () => {
    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[
          appt({ id: "a1", time_start: "11:00:00", title: "Teleconsulta", modality: "online" }),
        ]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText("Presencial")).not.toBeInTheDocument();
  });

  it("chama onSelectAppointment com o compromisso correto ao clicar no chip (desktop)", async () => {
    const user = userEvent.setup();
    const onSelectAppointment = vi.fn();
    const a1 = appt({ id: "a1", time_start: "09:00:00", title: "Primeiro" });
    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[a1]}
        appointmentLabel="Compromisso"
        onSelectAppointment={onSelectAppointment}
      />,
    );

    await user.click(screen.getByText("Primeiro"));
    expect(onSelectAppointment).toHaveBeenCalledWith(a1);
  });
});

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

describe("WeeklyCalendar -- modo mobile", () => {
  afterEach(() => {
    setInnerWidth(1024);
  });

  it("pré-seleciona a aba do dia de hoje e mostra só os compromissos desse dia", async () => {
    // 2026-07-15 é uma quarta-feira -- índice 2 ("Qua") dentro da semana que
    // começa em 2026-07-13 (segunda). `useIsMobile` lê window.innerWidth
    // diretamente (não mql.matches -- ver src/hooks/use-mobile.tsx), então só
    // precisamos setar innerWidth; `toFake: ["Date"]` mantém os timers reais
    // (setTimeout) intactos para o polling do waitFor/findBy funcionar.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
    setInnerWidth(500);

    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[
          appt({ id: "a1", date: "2026-07-15", time_start: "10:00:00", title: "Consulta Quarta" }),
          appt({ id: "a2", date: "2026-07-13", time_start: "10:00:00", title: "Consulta Segunda" }),
        ]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Consulta Quarta")).toBeInTheDocument());
    expect(screen.queryByText("Consulta Segunda")).not.toBeInTheDocument();
  });

  it("alternar para outra aba de dia troca os compromissos exibidos", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
    setInnerWidth(500);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[
          appt({ id: "a1", date: "2026-07-15", time_start: "10:00:00", title: "Consulta Quarta" }),
          appt({ id: "a2", date: "2026-07-13", time_start: "10:00:00", title: "Consulta Segunda" }),
        ]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Consulta Quarta")).toBeInTheDocument());
    const segundaTab = screen.getByText("13").closest("button");
    if (!segundaTab) throw new Error("aba de segunda-feira não encontrada");
    await user.click(segundaTab);

    expect(await screen.findByText("Consulta Segunda")).toBeInTheDocument();
    expect(screen.queryByText("Consulta Quarta")).not.toBeInTheDocument();
  });

  it("quando a semana exibida não contém o dia de hoje, cai no primeiro dia (índice 0)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Bem fora da semana de WEEK_START (2026-07-13 a 2026-07-19).
    vi.setSystemTime(new Date(2030, 0, 1, 12, 0, 0));
    setInnerWidth(500);

    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[
          appt({ id: "a1", date: "2026-07-13", time_start: "10:00:00", title: "Consulta Segunda" }),
          appt({ id: "a2", date: "2026-07-14", time_start: "10:00:00", title: "Consulta Terça" }),
        ]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Consulta Segunda")).toBeInTheDocument());
    expect(screen.queryByText("Consulta Terça")).not.toBeInTheDocument();
  });

  it("bucketiza um compromisso fora da hora cheia também no mobile", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 13, 12, 0, 0));
    setInnerWidth(500);

    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[
          appt({
            id: "a1",
            date: "2026-07-13",
            time_start: "14:30:00",
            title: "Sincronizado Feegow",
          }),
        ]}
        appointmentLabel="Compromisso"
        onSelectAppointment={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Sincronizado Feegow")).toBeInTheDocument());
    expect(screen.getByText("14:30")).toBeInTheDocument();
  });

  it("clicar no chip de um compromisso chama onSelectAppointment com o compromisso correto", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 13, 12, 0, 0));
    setInnerWidth(500);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSelectAppointment = vi.fn();
    const a1 = appt({
      id: "a1",
      date: "2026-07-13",
      time_start: "10:00:00",
      title: "Consulta Segunda",
    });

    render(
      <WeeklyCalendar
        weekStart={WEEK_START}
        appointments={[a1]}
        appointmentLabel="Compromisso"
        onSelectAppointment={onSelectAppointment}
      />,
    );

    await waitFor(() => expect(screen.getByText("Consulta Segunda")).toBeInTheDocument());
    await user.click(screen.getByText("Consulta Segunda"));
    expect(onSelectAppointment).toHaveBeenCalledWith(a1);
  });
});
