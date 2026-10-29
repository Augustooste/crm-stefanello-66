import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { TeamTab } from "./TeamTab";

const useCurrentProfileMock = vi.fn();
const useAuthMock = vi.fn();

const membersOrderMock = vi.fn();
const invitesOrderMock = vi.fn();

// A lista de membros deixou de sair de `profiles` e passou a vir da RPC
// `get_tenant_team`: o grant de coluna do e-mail foi revogado, e a RPC entrega
// o endereço só para o próprio usuário e para admins do mesmo workspace.
const rpcMock = vi.fn();
const profilesUpdateEqMock = vi.fn();
const profilesUpdateMock = vi.fn();

const invitesDeleteEqMock = vi.fn();
const invitesDeleteInMock = vi.fn();
const invitesDeleteMock = vi.fn();
const invitesUpdateEqMock = vi.fn();
const invitesUpdateMaybeSingleMock = vi.fn();
const invitesUpdateMock = vi.fn();
const invitesInsertSelectMaybeSingleMock = vi.fn();
const invitesInsertMock = vi.fn();
/** Convites ainda abertos do tenant, lidos antes de criar um novo (dedupe por e-mail). */
const invitesOpenSelectMock = vi.fn();

const fromMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/lib/auth/AuthProvider", () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function profilesTable() {
  // Só escrita: a leitura da equipe agora é a RPC `get_tenant_team`.
  return {
    update: profilesUpdateMock,
  };
}

function invitesTable() {
  return {
    // Duas leituras diferentes: a lista da tela pede `token`; a checagem de
    // convites duplicados (antes de criar) pede só `id, email`.
    select: (columns: string) =>
      columns.includes("token")
        ? { is: () => ({ order: () => invitesOrderMock() }) }
        : { eq: () => ({ is: () => invitesOpenSelectMock() }) },
    delete: invitesDeleteMock,
    update: invitesUpdateMock,
    insert: invitesInsertMock,
  };
}

/** Token enviado no último `update` de convites — o mock do banco ecoa esse valor. */
function lastUpdatedToken(): string | undefined {
  const patch = invitesUpdateMock.mock.calls.at(-1)?.[0];
  return typeof patch === "object" && patch !== null && "token" in patch
    ? String((patch as { token: unknown }).token)
    : undefined;
}

function mockClipboard() {
  // userEvent.setup() substitui navigator.clipboard pelo próprio polyfill — reaplica o mock depois.
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <TeamTab />
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

describe("TeamTab", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    useAuthMock.mockReset();
    membersOrderMock.mockReset();
    invitesOrderMock.mockReset();
    profilesUpdateEqMock.mockReset();
    profilesUpdateMock.mockReset();
    invitesDeleteEqMock.mockReset();
    invitesDeleteInMock.mockReset();
    invitesDeleteMock.mockReset();
    invitesUpdateEqMock.mockReset();
    invitesUpdateMaybeSingleMock.mockReset();
    invitesUpdateMock.mockReset();
    invitesInsertSelectMaybeSingleMock.mockReset();
    invitesInsertMock.mockReset();
    invitesOpenSelectMock.mockReset();
    fromMock.mockReset();
    rpcMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
    useAuthMock.mockReturnValue({ user: { id: "me" } });
    membersOrderMock.mockResolvedValue({ data: [], error: null });
    // `membersOrderMock` continua sendo a fonte dos membros nos testes; a RPC
    // só troca o caminho até ela.
    rpcMock.mockImplementation((fn: string) =>
      fn === "get_tenant_team" ? membersOrderMock() : Promise.resolve({ data: [], error: null }),
    );
    invitesOrderMock.mockResolvedValue({ data: [], error: null });
    profilesUpdateEqMock.mockResolvedValue({ error: null });
    profilesUpdateMock.mockReturnValue({ eq: profilesUpdateEqMock });
    invitesDeleteEqMock.mockResolvedValue({ error: null });
    invitesDeleteInMock.mockResolvedValue({ error: null });
    invitesDeleteMock.mockReturnValue({ eq: invitesDeleteEqMock, in: invitesDeleteInMock });
    // O banco devolve o que foi gravado: o read-back ecoa o token do update.
    invitesUpdateMaybeSingleMock.mockImplementation(() =>
      Promise.resolve({ data: { token: lastUpdatedToken() ?? "tok-novo" }, error: null }),
    );
    invitesUpdateEqMock.mockReturnValue({
      select: () => ({ maybeSingle: () => invitesUpdateMaybeSingleMock() }),
    });
    invitesUpdateMock.mockReturnValue({ eq: invitesUpdateEqMock });
    invitesOpenSelectMock.mockResolvedValue({ data: [], error: null });
    invitesInsertMock.mockReturnValue({
      select: () => ({ maybeSingle: () => invitesInsertSelectMaybeSingleMock() }),
    });
    invitesInsertSelectMaybeSingleMock.mockResolvedValue({
      data: { token: "tok123" },
      error: null,
    });

    fromMock.mockImplementation((table: string) =>
      table === "profiles" ? profilesTable() : invitesTable(),
    );
  });

  function member(
    overrides: Partial<{
      id: string;
      name: string;
      email: string | null;
      role: "admin" | "agent";
      disabled: boolean;
    }> = {},
  ) {
    return {
      id: "u1",
      name: "Ana",
      email: "ana@example.com",
      role: "agent" as const,
      disabled: false,
      ...overrides,
    };
  }

  it("mostra o skeleton de membros e convites enquanto carregam", () => {
    membersOrderMock.mockImplementation(() => new Promise(() => {}));
    invitesOrderMock.mockImplementation(() => new Promise(() => {}));

    renderTab();

    expect(screen.getByText("Equipe")).toBeInTheDocument();
    expect(screen.queryByText("Sem membros")).not.toBeInTheDocument();
  });

  it("mostra EmptyState quando não há membros nem convites", async () => {
    renderTab();

    expect(await screen.findByText("Sem membros")).toBeInTheDocument();
    expect(await screen.findByText("Nenhum convite pendente")).toBeInTheDocument();
    expect(screen.getByText("Convites aparecerão aqui até serem aceitos.")).toBeInTheDocument();
  });

  it("não quebra quando a query de membros falha — mostra o EmptyState", async () => {
    membersOrderMock.mockResolvedValue({ data: null, error: new Error("Falha ao buscar membros") });

    renderTab();

    expect(await screen.findByText("Sem membros")).toBeInTheDocument();
  });

  it("trata data nulo da query de membros como lista vazia", async () => {
    membersOrderMock.mockResolvedValue({ data: null, error: null });

    renderTab();

    expect(await screen.findByText("Sem membros")).toBeInTheDocument();
  });

  it("trata data nulo da query de convites como lista vazia", async () => {
    invitesOrderMock.mockResolvedValue({ data: null, error: null });

    renderTab();

    expect(await screen.findByText("Nenhum convite pendente")).toBeInTheDocument();
  });

  it("não quebra quando a query de convites falha — mostra o EmptyState", async () => {
    invitesOrderMock.mockResolvedValue({
      data: null,
      error: new Error("Falha ao buscar convites"),
    });

    renderTab();

    expect(await screen.findByText("Nenhum convite pendente")).toBeInTheDocument();
  });

  it("lista membros com status e indica o próprio usuário", async () => {
    membersOrderMock.mockResolvedValue({
      data: [
        member({ id: "me", name: "Eu Mesmo" }),
        member({ id: "u2", name: "Bruno", disabled: true }),
      ],
      error: null,
    });

    renderTab();

    expect(await screen.findByText("Eu Mesmo")).toBeInTheDocument();
    expect(screen.getByText("(você)")).toBeInTheDocument();
    expect(screen.getByText("Bruno")).toBeInTheDocument();
    expect(screen.getByText("Ativo")).toBeInTheDocument();
    expect(screen.getByText("Desativado")).toBeInTheDocument();
  });

  it('mostra "—" quando o e-mail do membro é nulo', async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ email: null })],
      error: null,
    });

    renderTab();

    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("não permite desativar a si mesmo", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "me", name: "Eu Mesmo" })],
      error: null,
    });

    renderTab();

    const button = await screen.findByRole("button", { name: "Desativar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Você não pode desativar a si mesmo");
  });

  it("não permite desativar o único admin ativo", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "u2", name: "Admin Único", role: "admin" })],
      error: null,
    });

    renderTab();

    const button = await screen.findByRole("button", { name: "Desativar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Deve haver ao menos um administrador ativo");
  });

  it("permite desativar quando há mais de um admin ativo", async () => {
    membersOrderMock.mockResolvedValue({
      data: [
        member({ id: "u2", name: "Admin A", role: "admin" }),
        member({ id: "u3", name: "Admin B", role: "admin" }),
      ],
      error: null,
    });
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("Admin A");
    const buttons = screen.getAllByRole("button", { name: "Desativar" });
    await user.click(buttons[0]);

    await waitFor(() => expect(profilesUpdateMock).toHaveBeenCalledWith({ disabled: true }));
    expect(profilesUpdateEqMock).toHaveBeenCalledWith("id", "u2");
    expect(toast.success).toHaveBeenCalledWith("Usuário atualizado");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["team-members"] });
  });

  it("reativa um membro desativado", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "u2", name: "Carla", disabled: true })],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Carla");
    const button = screen.getByRole("button", { name: "Reativar" });
    expect(button).not.toBeDisabled();
    await user.click(button);

    await waitFor(() => expect(profilesUpdateMock).toHaveBeenCalledWith({ disabled: false }));
  });

  it("mostra toast de erro quando desativar/reativar falha, com mensagem padrão sem mensagem", async () => {
    membersOrderMock.mockResolvedValue({
      data: [
        member({ id: "u2", name: "Admin A", role: "admin" }),
        member({ id: "u3", name: "Admin B", role: "admin" }),
      ],
      error: null,
    });
    profilesUpdateEqMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Admin A");
    const buttons = screen.getAllByRole("button", { name: "Desativar" });
    await user.click(buttons[0]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro"));
  });

  it("altera o papel de um membro via select", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "u2", name: "Carla", role: "agent" })],
      error: null,
    });
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("Carla");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Administrador" }));

    await waitFor(() => expect(profilesUpdateMock).toHaveBeenCalledWith({ role: "admin" }));
    expect(profilesUpdateEqMock).toHaveBeenCalledWith("id", "u2");
    expect(toast.success).toHaveBeenCalledWith("Papel atualizado");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["team-members"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["current-profile"] });
  });

  it("mostra toast de erro com mensagem quando alterar papel falha", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "u2", name: "Carla", role: "agent" })],
      error: null,
    });
    profilesUpdateEqMock.mockResolvedValue({ error: new Error("Falha ao mudar papel") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Carla");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Administrador" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao mudar papel"));
  });

  it('usa a mensagem padrão "Erro" quando o erro ao mudar o papel não tem mensagem', async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "u2", name: "Carla", role: "agent" })],
      error: null,
    });
    profilesUpdateEqMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Carla");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Administrador" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro"));
  });

  it("bloqueia rebaixar a si mesmo quando é o único admin ativo", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "me", name: "Eu Admin", role: "admin" })],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Eu Admin");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Atendente" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Não é possível: deve haver ao menos um administrador ativo.",
      ),
    );
    expect(profilesUpdateMock).not.toHaveBeenCalled();
  });

  it("bloqueia rebaixar outro admin quando é o único admin ativo", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "u2", name: "Único Admin", role: "admin" })],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Único Admin");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Atendente" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Não é possível: deve haver ao menos um administrador ativo.",
      ),
    );
    expect(profilesUpdateMock).not.toHaveBeenCalled();
  });

  it("select de papel fica desabilitado para membros desativados", async () => {
    membersOrderMock.mockResolvedValue({
      data: [member({ id: "u2", name: "Desativada", disabled: true })],
      error: null,
    });

    renderTab();

    await screen.findByText("Desativada");
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("mostra o EmptyState de convites quando não há convites pendentes", async () => {
    renderTab();

    expect(await screen.findByText("Nenhum convite pendente")).toBeInTheDocument();
  });

  it("lista convites pendentes com papel e expiração", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "novo@example.com",
          role: "admin",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });

    renderTab();

    expect(await screen.findByText("novo@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Papel: Admin/)).toBeInTheDocument();
  });

  it("mostra convite expirado quando expires_at já passou", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "expirado@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() - 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });

    renderTab();

    expect(await screen.findByText(/Expirado/)).toBeInTheDocument();
  });

  it("copia o link do convite para a área de transferência", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "novo@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    const writeText = mockClipboard();
    renderTab();

    await screen.findByText("novo@example.com");
    await user.click(screen.getByRole("button", { name: /Copiar link/ }));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/auth?invite=tok1"));
    expect(toast.success).toHaveBeenCalledWith("Link copiado");
  });

  it("gera um novo link de convite e mostra o dialog com o link atualizado", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "reenvio@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("reenvio@example.com");
    await user.click(screen.getByRole("button", { name: /Gerar novo link/ }));

    expect(await screen.findByText("Link de convite")).toBeInTheDocument();

    // Renovar tem que TROCAR o segredo, não só esticar a validade: se o link
    // antigo vazou, prorrogá-lo revive o vazamento por mais 7 dias.
    const novoToken = lastUpdatedToken();
    expect(novoToken).toBeTruthy();
    expect(novoToken).not.toBe("tok1");
    expect(invitesUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: novoToken, expires_at: expect.any(String) }),
    );
    expect(invitesUpdateEqMock).toHaveBeenCalledWith("id", "i1");
    // O link mostrado é o token novo lido de volta do banco, não o `tok1` da lista.
    expect(
      screen.getByDisplayValue(`${window.location.origin}/auth?invite=${novoToken}`),
    ).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/\/auth\?invite=tok1$/)).not.toBeInTheDocument();
    // O app não dispara e-mail: o rótulo antigo ("Reenviar") e o toast
    // ("Convite reenviado") prometiam um envio que nunca acontecia.
    expect(toast.success).toHaveBeenCalledWith(
      "Novo link gerado, válido por mais 7 dias. O link anterior deixou de valer. Copie e envie você mesmo.",
    );
    expect(screen.queryByRole("button", { name: /Reenviar/ })).not.toBeInTheDocument();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["team-invites"] });
  });

  it("avisa quando renovar não encontra o convite, em vez de mostrar um link que não existe", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "sumiu@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    // Update que não pega nenhuma linha volta sem erro: sem o read-back, a tela
    // mostraria "novo link gerado" com o token velho ainda valendo.
    invitesUpdateMaybeSingleMock.mockResolvedValue({ data: null, error: null });
    const user = userEvent.setup({ delay: null });
    renderTab();

    await screen.findByText("sumiu@example.com");
    await user.click(screen.getByRole("button", { name: /Gerar novo link/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Convite não encontrado. Atualize a lista e tente de novo.",
      ),
    );
    expect(screen.queryByText("Link de convite")).not.toBeInTheDocument();
  });

  it("mostra erro quando gerar o novo link falha", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "falha@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    invitesUpdateMaybeSingleMock.mockResolvedValue({
      data: null,
      error: new Error("Falha ao reenviar"),
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("falha@example.com");
    await user.click(screen.getByRole("button", { name: /Gerar novo link/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao reenviar"));
  });

  it('usa a mensagem padrão "Erro" quando o erro ao gerar o link não tem mensagem', async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "falha@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    invitesUpdateMaybeSingleMock.mockResolvedValue({ data: null, error: {} });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("falha@example.com");
    await user.click(screen.getByRole("button", { name: /Gerar novo link/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro"));
  });

  it("cancela um convite pendente", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "cancelar@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("cancelar@example.com");
    await user.click(screen.getByRole("button", { name: /Cancelar/ }));

    await waitFor(() => expect(invitesDeleteEqMock).toHaveBeenCalledWith("id", "i1"));
    expect(toast.success).toHaveBeenCalledWith("Convite cancelado");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["team-invites"] });
  });

  it("mostra erro quando cancelar convite falha", async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "cancelar@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    invitesDeleteEqMock.mockResolvedValue({ error: new Error("Falha ao cancelar") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("cancelar@example.com");
    await user.click(screen.getByRole("button", { name: /Cancelar/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao cancelar"));
  });

  it('usa a mensagem padrão "Erro" quando o erro ao cancelar não tem mensagem', async () => {
    invitesOrderMock.mockResolvedValue({
      data: [
        {
          id: "i1",
          email: "cancelar@example.com",
          role: "agent",
          token: "tok1",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    invitesDeleteEqMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("cancelar@example.com");
    await user.click(screen.getByRole("button", { name: /Cancelar/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro"));
  });

  it("abre o dialog de convite, cria com e-mail e papel padrão (agent)", async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));

    expect(await screen.findByText("Convidar pessoa")).toBeInTheDocument();
    await user.type(screen.getByLabelText("E-mail *"), "Novo@Example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() =>
      expect(invitesInsertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: "tenant-1",
          email: "novo@example.com",
          role: "agent",
          created_by: "me",
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Convite criado");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["team-invites"] });
    expect(await screen.findByText("Link de convite")).toBeInTheDocument();
  });

  it("cria convite com papel admin selecionado", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "admin@example.com");

    const selects = screen.getAllByRole("combobox");
    await user.click(selects[selects.length - 1]);
    await user.click(await screen.findByRole("option", { name: "Administrador" }));
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() =>
      expect(invitesInsertMock).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" })),
    );
  });

  it("botão de criar convite fica desabilitado sem e-mail", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));

    expect(screen.getByRole("button", { name: "Criar convite" })).toBeDisabled();
  });

  it("cancela o dialog de convite sem criar nada", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("Convidar pessoa")).not.toBeInTheDocument());
    expect(invitesInsertMock).not.toHaveBeenCalled();
  });

  it("mostra toast de erro com mensagem quando criar convite falha", async () => {
    invitesInsertSelectMaybeSingleMock.mockResolvedValue({
      data: null,
      error: new Error("E-mail já convidado"),
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "dup@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("E-mail já convidado"));
  });

  it('usa a mensagem padrão "Erro ao criar convite" quando o erro não tem mensagem', async () => {
    invitesInsertSelectMaybeSingleMock.mockResolvedValue({ data: null, error: {} });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "dup@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao criar convite"));
  });

  it('mostra "Criando…" enquanto a criação do convite está pendente', async () => {
    let resolveInsert: (value: { data: { token: string }; error: null }) => void = () => {};
    invitesInsertSelectMaybeSingleMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInsert = resolve;
        }),
    );
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "pendente@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    expect(await screen.findByRole("button", { name: "Criando…" })).toBeInTheDocument();
    resolveInsert({ data: { token: "tokX" }, error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("copia o link no dialog de link de convite e fecha ao clicar em Fechar", async () => {
    const user = userEvent.setup();
    const writeText = mockClipboard();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "novo@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await screen.findByText("Link de convite");
    const linkInput = screen.getByDisplayValue(/\/auth\?invite=tok123/);
    const copyIconButton = linkInput.parentElement?.querySelector("button");
    expect(copyIconButton).toBeTruthy();
    await user.click(copyIconButton as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/auth?invite=tok123"));

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    await waitFor(() => expect(screen.queryByText("Link de convite")).not.toBeInTheDocument());
  });

  it("fecha o dialog de link de convite ao pressionar Escape", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "novo@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await screen.findByText("Link de convite");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Link de convite")).not.toBeInTheDocument());
  });

  it("cria convite com created_by nulo quando não há usuário autenticado", async () => {
    useAuthMock.mockReturnValue({ user: null });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "semusuario@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() =>
      expect(invitesInsertMock).toHaveBeenCalledWith(expect.objectContaining({ created_by: null })),
    );
  });

  it("apaga o convite aberto do mesmo e-mail antes de criar o novo, ignorando maiúsculas", async () => {
    // Sem UNIQUE em (tenant_id, lower(email)), sobrariam dois convites abertos e
    // o papel do convidado passaria a depender de qual link ele ainda tem.
    invitesOpenSelectMock.mockResolvedValue({
      data: [
        { id: "antigo", email: "Duplicado@Example.com" },
        { id: "outro", email: "outra.pessoa@example.com" },
      ],
      error: null,
    });
    const user = userEvent.setup({ delay: null });
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "duplicado@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() => expect(invitesDeleteInMock).toHaveBeenCalledWith("id", ["antigo"]));
    expect(invitesInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "duplicado@example.com" }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Convite criado. O convite anterior para este e-mail deixou de valer.",
    );
  });

  it("não apaga nada quando não há convite aberto para o mesmo e-mail", async () => {
    invitesOpenSelectMock.mockResolvedValue({
      data: [{ id: "outro", email: "outra.pessoa@example.com" }],
      error: null,
    });
    const user = userEvent.setup({ delay: null });
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "novo@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() => expect(invitesInsertMock).toHaveBeenCalled());
    expect(invitesDeleteInMock).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Convite criado");
  });

  it("não cria o convite se a limpeza do convite duplicado falhar", async () => {
    // Falha fechada: inserir mesmo assim recriaria a duplicidade em silêncio.
    invitesOpenSelectMock.mockResolvedValue({
      data: [{ id: "antigo", email: "duplicado@example.com" }],
      error: null,
    });
    invitesDeleteInMock.mockResolvedValue({ error: new Error("Sem permissão para apagar") });
    const user = userEvent.setup({ delay: null });
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "duplicado@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sem permissão para apagar"));
    expect(invitesInsertMock).not.toHaveBeenCalled();
  });

  it("mostra erro quando a leitura dos convites abertos falha, sem criar convite", async () => {
    invitesOpenSelectMock.mockResolvedValue({
      data: null,
      error: new Error("Falha ao ler convites"),
    });
    const user = userEvent.setup({ delay: null });
    renderTab();

    await screen.findByText("Sem membros");
    await user.click(screen.getByRole("button", { name: "Convidar" }));
    await user.type(screen.getByLabelText("E-mail *"), "qualquer@example.com");
    await user.click(screen.getByRole("button", { name: "Criar convite" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao ler convites"));
    expect(invitesInsertMock).not.toHaveBeenCalled();
  });
});
