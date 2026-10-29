import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import {
  createFromByTable,
  createQueryBuilder,
  ok,
  fail,
  type QueryResult,
} from "@/test/supabase-mock";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import type { WeeklyReportRecipientRow, WeeklyReportRow } from "@/hooks/use-weekly-digest";
import { NotificationsTab } from "./NotificationsTab";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const DigestSemanalPage = NotificationsTab;

function mockProfile(profile: CurrentProfile) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
    isLoading: false,
  } as UseQueryResult<CurrentProfile | null, Error>);
}

function mockDigest(overrides: Partial<Record<string, QueryResult>> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      weekly_report_recipients: ok([]),
      weekly_reports: ok([]),
      ...overrides,
    }),
  );
}

const EMAIL_RECIPIENT: WeeklyReportRecipientRow = {
  id: "rec-1",
  tenant_id: "t1",
  channel: "email",
  address: "gestor@empresa.com",
  name: "Ana Gestora",
  active: true,
};

const WHATSAPP_RECIPIENT: WeeklyReportRecipientRow = {
  id: "rec-2",
  tenant_id: "t1",
  channel: "whatsapp",
  address: "+5511900000000",
  name: null,
  active: false,
};

const REPORT_ROW: WeeklyReportRow = {
  id: "rep-1",
  tenant_id: "t1",
  // Meio-dia UTC -- evita que o teste rende no dia anterior/seguinte por
  // causa do fuso local ao converter para Date (formatDate usa hora local).
  period_start: "2026-07-06T12:00:00.000Z",
  period_end: "2026-07-12T12:00:00.000Z",
  status: "sent",
  created_at: "2026-07-13T00:00:00.000Z",
  weekly_report_deliveries: [
    {
      id: "del-1",
      report_id: "rep-1",
      recipient_id: "rec-1",
      channel: "email",
      address: "gestor@empresa.com",
      status: "sent",
      attempt_count: 1,
      updated_at: "2026-07-13T00:05:00.000Z",
    },
    {
      id: "del-2",
      report_id: "rep-1",
      recipient_id: "rec-2",
      channel: "whatsapp",
      address: "+5511900000000",
      status: "failed",
      attempt_count: 3,
      updated_at: "2026-07-13T00:10:00.000Z",
    },
  ],
};

// head()/SEO não se aplica mais -- NotificationsTab é uma aba dentro de
// /configuracoes (ver _app.configuracoes.test.tsx). Redirect da antiga rota
// /digest-semanal tem teste próprio em _app.digest-semanal.test.tsx.

describe("NotificationsTab (aba 'Notificações' em Configurações)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("mostra estado de erro com opção de tentar novamente quando destinatários falham", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockDigest({ weekly_report_recipients: fail("timeout ao buscar destinatários") });
    renderWithQueryClient(<DigestSemanalPage />);

    expect(await screen.findByText("timeout ao buscar destinatários")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it("traduz o jargão do Postgres em vez de jogá-lo no estado de erro", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockDigest({
      weekly_report_recipients: fail("permission denied for table weekly_report_recipients"),
    });
    renderWithQueryClient(<DigestSemanalPage />);

    expect(
      await screen.findByText("Você não tem permissão para fazer isso. Peça a um administrador."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();
  });

  it("traduz o jargão do Postgres no histórico de relatórios", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockDigest({
      weekly_report_recipients: ok([]),
      weekly_reports: fail('relation "public.weekly_reports" does not exist'),
    });
    renderWithQueryClient(<DigestSemanalPage />);

    expect(
      await screen.findByText("Não foi possível carregar os relatórios agora."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/relation "public/i)).not.toBeInTheDocument();
  });

  it("quando não há destinatários, mostra estado vazio", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockDigest();
    renderWithQueryClient(<DigestSemanalPage />);

    expect(await screen.findByText("Nenhum destinatário")).toBeInTheDocument();
  });

  it("lista destinatários com nome, canal, endereço e status ativo/inativo", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockDigest({
      weekly_report_recipients: ok([EMAIL_RECIPIENT, WHATSAPP_RECIPIENT]),
    });
    renderWithQueryClient(<DigestSemanalPage />);

    expect(await screen.findByText("Ana Gestora")).toBeInTheDocument();
    expect(screen.getByText("E-mail")).toBeInTheDocument();
    expect(screen.getByText("gestor@empresa.com")).toBeInTheDocument();
    expect(screen.getByText("Ativo")).toBeInTheDocument();

    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("+5511900000000")).toBeInTheDocument();
    expect(screen.getByText("Inativo")).toBeInTheDocument();
  });

  describe("CRUD de destinatários escondido de não-admin (mesmo padrão do /nurture)", () => {
    it("admin vê 'Novo destinatário', 'Editar' e 'Excluir'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest({ weekly_report_recipients: ok([EMAIL_RECIPIENT]) });
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      expect(screen.getByRole("button", { name: "Novo destinatário" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Editar Ana Gestora" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Excluir Ana Gestora" })).toBeInTheDocument();
    });

    it("não-admin não vê 'Novo destinatário' nem 'Editar'/'Excluir'", async () => {
      mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
      mockDigest({ weekly_report_recipients: ok([EMAIL_RECIPIENT]) });
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      expect(screen.queryByRole("button", { name: "Novo destinatário" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Editar Ana Gestora" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Excluir Ana Gestora" })).not.toBeInTheDocument();
    });

    it("admin cria destinatário preenchendo o formulário (insert direto, sem RPC)", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const recipientsBuilder = createQueryBuilder(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? recipientsBuilder
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );

      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Nenhum destinatário");
      await user.click(screen.getByRole("button", { name: "Novo destinatário" }));

      await user.type(screen.getByLabelText("E-mail *"), "novo@empresa.com");
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      expect(recipientsBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: "t1",
          channel: "email",
          address: "novo@empresa.com",
          name: null,
          active: true,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Destinatário criado");
    });
  });

  describe("histórico de envios", () => {
    it("quando não há relatórios, mostra estado vazio", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest();
      renderWithQueryClient(<DigestSemanalPage />);

      expect(await screen.findByText("Nenhum relatório gerado ainda")).toBeInTheDocument();
    });

    it("renderiza período, status e contagem de entregas por sucesso/falha", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest({ weekly_reports: ok([REPORT_ROW]) });
      renderWithQueryClient(<DigestSemanalPage />);

      expect(await screen.findByText("06/07/2026 – 12/07/2026")).toBeInTheDocument();
      expect(screen.getByText("Enviado")).toBeInTheDocument();
      expect(screen.getByText("1 sucesso · 1 falha")).toBeInTheDocument();
    });

    it("histórico renderiza igual para não-admin (leitura liberada pela RLS)", async () => {
      mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
      mockDigest({ weekly_reports: ok([REPORT_ROW]) });
      renderWithQueryClient(<DigestSemanalPage />);

      expect(await screen.findByText("06/07/2026 – 12/07/2026")).toBeInTheDocument();
      expect(screen.getByText("1 sucesso · 1 falha")).toBeInTheDocument();
    });

    it("mostra a contagem de pendentes quando há entregas 'pending'/'sending'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const reportWithPending: WeeklyReportRow = {
        ...REPORT_ROW,
        weekly_report_deliveries: [
          { ...REPORT_ROW.weekly_report_deliveries[0], status: "pending" },
          { ...REPORT_ROW.weekly_report_deliveries[1], status: "sending" },
        ],
      };
      mockDigest({ weekly_reports: ok([reportWithPending]) });
      renderWithQueryClient(<DigestSemanalPage />);

      expect(await screen.findByText("0 sucesso · 0 falha · 2 pendente")).toBeInTheDocument();
    });

    it("usa variante destructive quando o status do relatório é 'failed'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const failedReport: WeeklyReportRow = { ...REPORT_ROW, status: "failed" };
      mockDigest({ weekly_reports: ok([failedReport]) });
      renderWithQueryClient(<DigestSemanalPage />);

      const badge = await screen.findByText("Falhou");
      expect(badge.closest("span")).toHaveClass("text-destructive");
    });

    it("trata weekly_report_deliveries ausente como lista vazia, sem quebrar", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const reportWithoutDeliveries = {
        ...REPORT_ROW,
        weekly_report_deliveries: undefined,
      } as unknown as WeeklyReportRow;
      mockDigest({ weekly_reports: ok([reportWithoutDeliveries]) });
      renderWithQueryClient(<DigestSemanalPage />);

      expect(await screen.findByText("0 sucesso · 0 falha")).toBeInTheDocument();
    });
  });

  describe("retry em estados de erro", () => {
    it("clique em 'Tentar novamente' nos destinatários dispara refetch", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest({ weekly_report_recipients: fail("timeout ao buscar destinatários") });
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("timeout ao buscar destinatários");
      const callsBefore = vi
        .mocked(supabase.from)
        .mock.calls.filter(
          (c) => (c[0] as unknown as string) === "weekly_report_recipients",
        ).length;

      await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

      await waitFor(() => {
        const callsAfter = vi
          .mocked(supabase.from)
          .mock.calls.filter(
            (c) => (c[0] as unknown as string) === "weekly_report_recipients",
          ).length;
        expect(callsAfter).toBeGreaterThan(callsBefore);
      });
    });

    it("clique em 'Tentar novamente' no histórico dispara refetch", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest({ weekly_reports: fail("timeout ao buscar relatórios") });
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("timeout ao buscar relatórios");
      const callsBefore = vi
        .mocked(supabase.from)
        .mock.calls.filter((c) => (c[0] as unknown as string) === "weekly_reports").length;

      await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

      await waitFor(() => {
        const callsAfter = vi
          .mocked(supabase.from)
          .mock.calls.filter((c) => (c[0] as unknown as string) === "weekly_reports").length;
        expect(callsAfter).toBeGreaterThan(callsBefore);
      });
    });
  });

  describe("editar destinatário", () => {
    it("abre o formulário pré-preenchido com os dados do destinatário (canal whatsapp)", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest({ weekly_report_recipients: ok([WHATSAPP_RECIPIENT]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("WhatsApp");
      await user.click(screen.getByRole("button", { name: "Editar +5511900000000" }));

      expect(screen.getByText("Editar destinatário")).toBeInTheDocument();
      expect(screen.getByLabelText("Telefone (WhatsApp) *")).toHaveValue("+5511900000000");
      expect(screen.getByLabelText("Ativo")).not.toBeChecked();
    });

    it("atualiza um destinatário existente chamando update com o id (não insert)", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const recipientsBuilder = createQueryBuilder(ok([EMAIL_RECIPIENT]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? recipientsBuilder
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      await user.click(screen.getByRole("button", { name: "Editar Ana Gestora" }));
      await user.clear(screen.getByLabelText("E-mail *"));
      await user.type(screen.getByLabelText("E-mail *"), "novo-email@empresa.com");
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Destinatário atualizado"));
      expect(recipientsBuilder.update).toHaveBeenCalledWith({
        channel: "email",
        address: "novo-email@empresa.com",
        name: "Ana Gestora",
        active: true,
      });
      expect(recipientsBuilder.eq).toHaveBeenCalledWith("id", "rec-1");
      expect(recipientsBuilder.insert).not.toHaveBeenCalled();
    });

    it("erro ao atualizar destinatário mostra toast de erro com a mensagem da falha", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? {
              select: () => ({ order: () => Promise.resolve(ok([EMAIL_RECIPIENT])) }),
              update: () => ({ eq: () => Promise.resolve(fail("endereço inválido")) }),
            }
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      await user.click(screen.getByRole("button", { name: "Editar Ana Gestora" }));
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("endereço inválido"));
    });
  });

  describe("excluir destinatário", () => {
    it("abre o dialog de confirmação com o nome do destinatário", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest({ weekly_report_recipients: ok([EMAIL_RECIPIENT]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      await user.click(screen.getByRole("button", { name: "Excluir Ana Gestora" }));

      expect(screen.getByText("Excluir destinatário")).toBeInTheDocument();
      expect(screen.getByText("Ana Gestora", { selector: "strong" })).toBeInTheDocument();
    });

    it("cancelar fecha o dialog sem excluir", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const recipientsBuilder = createQueryBuilder(ok([EMAIL_RECIPIENT]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? recipientsBuilder
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      await user.click(screen.getByRole("button", { name: "Excluir Ana Gestora" }));
      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      expect(screen.queryByText("Excluir destinatário")).not.toBeInTheDocument();
      expect(recipientsBuilder.delete).not.toHaveBeenCalled();
    });

    it("confirmar exclui, mostra toast de sucesso e fecha o dialog", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const recipientsBuilder = createQueryBuilder(ok([EMAIL_RECIPIENT]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? recipientsBuilder
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      await user.click(screen.getByRole("button", { name: "Excluir Ana Gestora" }));
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Destinatário removido"));
      expect(recipientsBuilder.delete).toHaveBeenCalledTimes(1);
      expect(recipientsBuilder.eq).toHaveBeenCalledWith("id", "rec-1");
      expect(screen.queryByText("Excluir destinatário")).not.toBeInTheDocument();
    });

    it("erro ao excluir mostra toast de erro com a mensagem da falha", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? {
              select: () => ({ order: () => Promise.resolve(ok([EMAIL_RECIPIENT])) }),
              delete: () => ({ eq: () => Promise.resolve(fail("violação de FK")) }),
            }
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Ana Gestora");
      await user.click(screen.getByRole("button", { name: "Excluir Ana Gestora" }));
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("violação de FK"));
    });
  });

  describe("formulário de novo destinatário", () => {
    it("botão Salvar fica desabilitado enquanto o endereço está vazio", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockDigest();
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Nenhum destinatário");
      await user.click(screen.getByRole("button", { name: "Novo destinatário" }));

      expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    });

    it("cancelar fecha o formulário sem chamar insert", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const recipientsBuilder = createQueryBuilder(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? recipientsBuilder
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Nenhum destinatário");
      await user.click(screen.getByRole("button", { name: "Novo destinatário" }));
      await user.type(screen.getByLabelText("E-mail *"), "a@a.com");
      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      expect(screen.queryByLabelText("E-mail *")).not.toBeInTheDocument();
      expect(recipientsBuilder.insert).not.toHaveBeenCalled();
    });

    it("trocar o canal para WhatsApp muda rótulo/placeholder do endereço e cria com esse canal", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const recipientsBuilder = createQueryBuilder(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? recipientsBuilder
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Nenhum destinatário");
      await user.click(screen.getByRole("button", { name: "Novo destinatário" }));
      await user.click(screen.getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "WhatsApp" }));

      const addressInput = screen.getByLabelText("Telefone (WhatsApp) *");
      expect(addressInput).toHaveAttribute("placeholder", "+55 11 90000-0000");

      await user.type(addressInput, "+5511988887777");
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(recipientsBuilder.insert).toHaveBeenCalledTimes(1));
      expect(recipientsBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "whatsapp", address: "+5511988887777" }),
      );
    });

    it("erro ao criar destinatário mostra toast de erro com a mensagem da falha", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "weekly_report_recipients"
          ? {
              select: () => ({ order: () => Promise.resolve(ok([])) }),
              insert: () => Promise.resolve(fail("endereço duplicado")),
            }
          : createFromByTable({ weekly_reports: ok([]) })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<DigestSemanalPage />);

      await screen.findByText("Nenhum destinatário");
      await user.click(screen.getByRole("button", { name: "Novo destinatário" }));
      await user.type(screen.getByLabelText("E-mail *"), "novo@empresa.com");
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("endereço duplicado"));
    });
  });
});
