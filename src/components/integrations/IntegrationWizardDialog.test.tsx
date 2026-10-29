import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { CatalogField } from "./IntegrationCard";
import { IntegrationWizardDialog, stepIndexForError } from "./IntegrationWizardDialog";
import type { WizardDef } from "@/lib/integrations/wizards/registry";

const wizard: WizardDef = {
  slug: "zapi",
  steps: [
    { title: "Passo 1", bullets: ["A"], fields: ["instance_id", "instance_token"] },
    { title: "Passo 2", bullets: ["B"], fields: ["client_token"], docsUrl: "https://example.com" },
  ],
};

const catalog: CatalogField[] = [
  { key: "instance_id", label: "Instance ID", help: "id", type: "text" },
  { key: "instance_token", label: "Instance Token", help: "tok", type: "password" },
  { key: "client_token", label: "Client Token", help: "ct", type: "password" },
];

function renderWizard(
  overrides: Partial<React.ComponentProps<typeof IntegrationWizardDialog>> = {},
) {
  const onSubmit = vi.fn();
  const props: React.ComponentProps<typeof IntegrationWizardDialog> = {
    slug: "zapi",
    wizard,
    catalog,
    tenantId: "t-1",
    submitting: false,
    onSubmit,
    ...overrides,
  };
  return { onSubmit, ...render(<IntegrationWizardDialog {...props} />) };
}

describe("IntegrationWizardDialog", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renderiza passos por slug e bloqueia 'Próximo' com campos vazios", () => {
    renderWizard();
    expect(screen.getByText(/Passo 1 de 2/)).toBeInTheDocument();
    const next = screen.getByRole("button", { name: /Próximo/i });
    expect(next).toBeDisabled();
  });

  it("avança para o próximo passo quando os campos são preenchidos", () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText("Instance Token"), { target: { value: "xyz" } });
    fireEvent.click(screen.getByRole("button", { name: /Próximo/i }));
    expect(screen.getByText(/Passo 2 de 2/)).toBeInTheDocument();
    // docsUrl aparece só neste passo
    expect(screen.getByText(/Abrir painel do provedor/i)).toBeInTheDocument();
  });

  it("chama onSubmit no último passo com todos os valores acumulados", () => {
    const { onSubmit } = renderWizard();
    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText("Instance Token"), { target: { value: "xyz" } });
    fireEvent.click(screen.getByRole("button", { name: /Próximo/i }));
    fireEvent.change(screen.getByLabelText("Client Token"), { target: { value: "ct1" } });
    fireEvent.click(screen.getByRole("button", { name: /Testar e conectar/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      instance_id: "abc",
      instance_token: "xyz",
      client_token: "ct1",
    });
  });

  it("persiste rascunho em localStorage (só campos não-password)", () => {
    const { unmount } = renderWizard();
    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: "abc" } });
    fireEvent.change(screen.getByLabelText("Instance Token"), { target: { value: "secret" } });
    const raw = window.localStorage.getItem("wizard-draft:t-1:zapi");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.instance_id).toBe("abc");
    expect(parsed.instance_token).toBeUndefined();
    unmount();

    // Nova montagem restaura o rascunho.
    renderWizard();
    expect((screen.getByLabelText("Instance ID") as HTMLInputElement).value).toBe("abc");
  });

  it("roteia erro do backend para o passo do campo problemático", () => {
    const { rerender } = renderWizard();
    // Preenche passo 1 e avança.
    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Instance Token"), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: /Próximo/i }));
    expect(screen.getByText(/Passo 2 de 2/)).toBeInTheDocument();

    // Erro mencionando `instance_id` -> volta ao passo 1 e marca aria-invalid.
    rerender(
      <IntegrationWizardDialog
        slug="zapi"
        wizard={wizard}
        catalog={catalog}
        tenantId="t-1"
        submitting={false}
        errorMessage="instance_id inválido"
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText(/Passo 1 de 2/)).toBeInTheDocument();
    expect(screen.getByLabelText("Instance ID")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("stepIndexForError", () => {
  it("retorna o passo do campo mencionado no erro", () => {
    const hit = stepIndexForError(wizard, "client_token ausente", catalog);
    expect(hit).toEqual({ step: 1, fieldKey: "client_token" });
  });

  it("retorna null quando nenhuma chave é mencionada", () => {
    expect(stepIndexForError(wizard, "erro genérico", catalog)).toBeNull();
    expect(stepIndexForError(wizard, undefined, catalog)).toBeNull();
  });
});
