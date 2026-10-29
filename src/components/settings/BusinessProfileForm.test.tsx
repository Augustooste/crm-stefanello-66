import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BusinessProfileForm,
  emptyBusinessProfile,
  normalizeBusinessProfile,
  type BusinessProfile,
} from "./BusinessProfileForm";

function Controlled({
  initial = emptyBusinessProfile(),
  showHelp,
}: {
  initial?: BusinessProfile;
  showHelp?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return <BusinessProfileForm value={value} onChange={setValue} showHelp={showHelp} />;
}

describe("emptyBusinessProfile", () => {
  it("gera um perfil vazio com dias úteis habilitados e fim de semana desabilitado", () => {
    const p = emptyBusinessProfile();

    expect(p.segment).toBe("");
    expect(p.team).toEqual([]);
    expect(p.offerings).toEqual([]);
    expect(p.hours.mon).toEqual({ enabled: true, open: "09:00", close: "18:00" });
    expect(p.hours.sat).toEqual({ enabled: false, open: "09:00", close: "18:00" });
    expect(p.hours.sun.enabled).toBe(false);
  });
});

describe("normalizeBusinessProfile", () => {
  it("retorna perfil vazio quando raw é null", () => {
    expect(normalizeBusinessProfile(null)).toEqual(emptyBusinessProfile());
  });

  it("retorna perfil vazio quando raw não é um objeto", () => {
    expect(normalizeBusinessProfile("string qualquer")).toEqual(emptyBusinessProfile());
    expect(normalizeBusinessProfile(42)).toEqual(emptyBusinessProfile());
  });

  it("mescla campos simples do raw sobre a base", () => {
    const result = normalizeBusinessProfile({ segment: "clínica", city: "SP" });
    expect(result.segment).toBe("clínica");
    expect(result.city).toBe("SP");
  });

  it("usa team da base quando raw.team não é array", () => {
    const result = normalizeBusinessProfile({ team: "não é array" });
    expect(result.team).toEqual([]);
  });

  it("usa team do raw quando é array", () => {
    const result = normalizeBusinessProfile({ team: ["Ana", "Beto"] });
    expect(result.team).toEqual(["Ana", "Beto"]);
  });

  it("usa offerings da base quando raw.offerings não é array", () => {
    const result = normalizeBusinessProfile({ offerings: {} });
    expect(result.offerings).toEqual([]);
  });

  it("usa offerings do raw quando é array", () => {
    const offerings = [{ name: "Corte", price: "R$ 50" }];
    const result = normalizeBusinessProfile({ offerings });
    expect(result.offerings).toEqual(offerings);
  });

  it("mescla hours do raw sobre a base quando é objeto", () => {
    const result = normalizeBusinessProfile({
      hours: { mon: { enabled: false, open: "10:00", close: "12:00" } },
    });
    expect(result.hours.mon).toEqual({ enabled: false, open: "10:00", close: "12:00" });
    expect(result.hours.tue).toEqual(emptyBusinessProfile().hours.tue);
  });

  it("usa hours da base quando raw.hours não é objeto", () => {
    const result = normalizeBusinessProfile({ hours: "não é objeto" });
    expect(result.hours).toEqual(emptyBusinessProfile().hours);
  });
});

describe("BusinessProfileForm", () => {
  it("exibe o texto de ajuda por padrão", () => {
    render(<Controlled />);
    expect(screen.getByText(/Esses dados ensinam a assistente de IA/)).toBeInTheDocument();
  });

  it("oculta o texto de ajuda quando showHelp é false", () => {
    render(<Controlled showHelp={false} />);
    expect(screen.queryByText(/Esses dados ensinam a assistente de IA/)).not.toBeInTheDocument();
  });

  it("edita segmento e cidade", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByLabelText("Segmento"), "Barbearia");
    await user.type(screen.getByLabelText("Cidade"), "Curitiba");

    expect(screen.getByLabelText("Segmento")).toHaveValue("Barbearia");
    expect(screen.getByLabelText("Cidade")).toHaveValue("Curitiba");
  });

  it('mostra mensagem "Nenhum membro adicionado ainda." quando equipe está vazia', () => {
    render(<Controlled />);
    expect(screen.getByText("Nenhum membro adicionado ainda.")).toBeInTheDocument();
  });

  it("adiciona um membro da equipe pelo botão Adicionar", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByPlaceholderText("Nome do membro"), "Carla");
    await user.click(screen.getAllByRole("button", { name: "Adicionar" })[0]);

    expect(screen.getByText("Carla")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Nome do membro")).toHaveValue("");
  });

  it("adiciona um membro da equipe pressionando Enter", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    const input = screen.getByPlaceholderText("Nome do membro");
    await user.type(input, "Diego{Enter}");

    expect(screen.getByText("Diego")).toBeInTheDocument();
  });

  it("não adiciona membro em branco nem duplicado", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.click(screen.getAllByRole("button", { name: "Adicionar" })[0]);
    expect(screen.getByText("Nenhum membro adicionado ainda.")).toBeInTheDocument();

    const input = screen.getByPlaceholderText("Nome do membro");
    await user.type(input, "Eva{Enter}");
    await user.type(input, "Eva{Enter}");

    expect(screen.getAllByText("Eva")).toHaveLength(1);
  });

  it("remove um membro da equipe", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByPlaceholderText("Nome do membro"), "Fábio{Enter}");
    expect(screen.getByText("Fábio")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remover Fábio" }));
    expect(screen.queryByText("Fábio")).not.toBeInTheDocument();
    expect(screen.getByText("Nenhum membro adicionado ainda.")).toBeInTheDocument();
  });

  it("edita responsável pelo atendimento humano e nome da assistente", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByLabelText("Responsável pelo atendimento humano"), "Ana (WhatsApp)");
    await user.type(screen.getByLabelText("Nome da assistente virtual"), "Sofia");

    expect(screen.getByLabelText("Responsável pelo atendimento humano")).toHaveValue(
      "Ana (WhatsApp)",
    );
    expect(screen.getByLabelText("Nome da assistente virtual")).toHaveValue("Sofia");
  });

  it("alterna o checkbox de dia habilitado e habilita os inputs de horário", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    const checkboxes = screen.getAllByRole("checkbox");
    // Sábado é o 6º dia listado (índice 5) e começa desabilitado.
    const satCheckbox = checkboxes[5];
    expect(satCheckbox).not.toBeChecked();

    await user.click(satCheckbox);
    expect(satCheckbox).toBeChecked();
  });

  it("edita o horário de abertura e fechamento de um dia habilitado", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    const timeInputs = document.querySelectorAll('input[type="time"]');
    const mondayOpen = timeInputs[0] as HTMLInputElement;
    const mondayClose = timeInputs[1] as HTMLInputElement;

    expect(mondayOpen).not.toBeDisabled();
    await user.clear(mondayOpen);
    await user.type(mondayOpen, "08:00");
    expect(mondayOpen).toHaveValue("08:00");

    await user.clear(mondayClose);
    await user.type(mondayClose, "17:00");
    expect(mondayClose).toHaveValue("17:00");
  });

  it("inputs de horário ficam desabilitados quando o dia está desabilitado", () => {
    render(<Controlled />);

    const timeInputs = document.querySelectorAll('input[type="time"]');
    // Sábado é o 6º dia (índices 10 e 11: 2 inputs por dia).
    const satOpen = timeInputs[10] as HTMLInputElement;
    expect(satOpen).toBeDisabled();
  });

  it("usa horário padrão (desabilitado 09:00-18:00) quando um dia falta em hours", () => {
    const partial = emptyBusinessProfile();
    const { sun: _sun, ...hoursWithoutSunday } = partial.hours;
    void _sun;
    render(
      <Controlled initial={{ ...partial, hours: hoursWithoutSunday as typeof partial.hours }} />,
    );

    // Domingo é o último dia (índices 12 e 13: 2 inputs por dia).
    const timeInputs = document.querySelectorAll('input[type="time"]');
    const sunOpen = timeInputs[12] as HTMLInputElement;
    const sunClose = timeInputs[13] as HTMLInputElement;
    expect(sunOpen).toHaveValue("09:00");
    expect(sunClose).toHaveValue("18:00");
    expect(sunOpen).toBeDisabled();
  });

  it('mostra "Nenhum item adicionado ainda." quando não há produtos/serviços', () => {
    render(<Controlled />);
    expect(screen.getByText("Nenhum item adicionado ainda.")).toBeInTheDocument();
  });

  it("adiciona um produto/serviço com preço", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByPlaceholderText("Nome do produto ou serviço"), "Corte de cabelo");
    await user.type(screen.getByPlaceholderText("Preço (opcional)"), "R$ 40");
    const addButtons = screen.getAllByRole("button", { name: "Adicionar" });
    await user.click(addButtons[addButtons.length - 1]);

    expect(screen.getByText("Corte de cabelo")).toBeInTheDocument();
    expect(screen.getByText("R$ 40")).toBeInTheDocument();
  });

  it("adiciona um produto/serviço sem preço", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByPlaceholderText("Nome do produto ou serviço"), "Consulta");
    const addButtons = screen.getAllByRole("button", { name: /Adicionar/ });
    await user.click(addButtons[addButtons.length - 1]);

    expect(screen.getByText("Consulta")).toBeInTheDocument();
  });

  it("não adiciona produto/serviço com nome em branco", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    const addButtons = screen.getAllByRole("button", { name: /Adicionar/ });
    await user.click(addButtons[addButtons.length - 1]);

    expect(screen.getByText("Nenhum item adicionado ainda.")).toBeInTheDocument();
  });

  it("remove um produto/serviço", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByPlaceholderText("Nome do produto ou serviço"), "Manicure");
    const addButtons = screen.getAllByRole("button", { name: /Adicionar/ });
    await user.click(addButtons[addButtons.length - 1]);
    expect(screen.getByText("Manicure")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remover Manicure" }));
    expect(screen.queryByText("Manicure")).not.toBeInTheDocument();
  });

  it("edita faixa de preço geral e link de portfólio", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByLabelText("Faixa de preço geral"), "R$ 100 a R$ 500");
    await user.type(screen.getByLabelText("Link de portfólio / site"), "https://exemplo.com");

    expect(screen.getByLabelText("Faixa de preço geral")).toHaveValue("R$ 100 a R$ 500");
    expect(screen.getByLabelText("Link de portfólio / site")).toHaveValue("https://exemplo.com");
  });

  it("edita observações adicionais e propaga via onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BusinessProfileForm value={emptyBusinessProfile()} onChange={onChange} />);

    await user.type(screen.getByLabelText("Observações adicionais"), "Detalhe extra");

    expect(onChange).toHaveBeenCalled();
  });
});
