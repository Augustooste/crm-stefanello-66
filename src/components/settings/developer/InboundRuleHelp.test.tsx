import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { INBOUND_PRESETS } from "@/lib/inbound-presets";
import { InboundRuleHelp } from "./InboundRuleHelp";

describe("InboundRuleHelp", () => {
  it.each(INBOUND_PRESETS.map((p) => [p.id, p.confirmed] as const))(
    "%s: aviso só quando o modelo não é confirmado",
    (id, confirmed) => {
      render(<InboundRuleHelp presetId={id} />);
      const warning = screen.queryByText("Confira na documentação do gateway");
      expect(warning !== null).toBe(!confirmed);
    },
  );

  it("documenta as respostas 200, 400, 401, 413, 429 (Retry-After) e 503", () => {
    render(<InboundRuleHelp presetId="stripe_checkout" />);
    const list = screen.getByLabelText("Respostas da URL").textContent ?? "";
    for (const code of ["200", "400", "401", "413", "429", "503", "Retry-After", "pausada", "30"]) {
      expect(list).toContain(code);
    }
    expect(list).not.toContain("202");
  });

  it.each([
    ["stripe_checkout", /Stripe reenvia por até 3 dias.*Dashboard.*15 dias/],
    ["asaas_payment", /Asaas pausa a fila após 15 falhas.*14 dias.*retoma no painel/],
    ["hotmart_purchase", /Hotmart pode desativar a configuração.*confira/],
  ] as const)("%s: diz o que o gateway faz com a regra pausada", (id, expected) => {
    const { container } = render(<InboundRuleHelp presetId={id} />);
    expect(container.textContent).toMatch(expected);
  });

  it.each(INBOUND_PRESETS.map((p) => p.id))(
    "%s: nunca promete que o gateway reenvia quando a regra voltar",
    (id) => {
      const { container } = render(<InboundRuleHelp presetId={id} />);
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/reenvia quando (ela|a regra) volta/);
      expect(text).not.toMatch(/guarda e reenvia/);
      expect(text).not.toMatch(/gateway deve reenviar/);
    },
  );

  it.each(INBOUND_PRESETS.map((p) => p.id))(
    "%s: não manda criar segunda regra (a lista cobre os dois eventos)",
    (id) => {
      const { container } = render(<InboundRuleHelp presetId={id} />);
      expect(container.textContent).not.toMatch(/segunda regra/i);
    },
  );

  it.each([
    ["stripe_checkout", /checkout\.session\.completed.*checkout\.session\.async_payment_succeeded/],
    ["asaas_payment", /PAYMENT_RECEIVED.*PAYMENT_CONFIRMED/],
  ] as const)("%s: explica que a regra já aceita os dois eventos", (id, events) => {
    const { container } = render(<InboundRuleHelp presetId={id} />);
    expect(container.textContent).toMatch(events);
    expect(container.textContent).toMatch(/Qualquer um de/);
  });

  it("Asaas avisa que PAYMENT_RECEIVED também sai de recebimento em dinheiro", () => {
    const { container } = render(<InboundRuleHelp presetId="asaas_payment" />);
    expect(container.textContent).toMatch(/RECEIVED_IN_CASH/);
    // Cartão: CONFIRMED na aprovação, RECEIVED ~32 dias depois (docs.asaas.com/docs/webhook-para-cobrancas).
    // Boleto também manda os dois; Pix só RECEIVED. Só RECEIVED atrasa o cartão; só CONFIRMED perde Pix.
    expect(container.textContent).toMatch(/cerca de 32 dias depois/);
    expect(container.textContent).toMatch(/Mantenha os dois/);
    // v2.2: o modelo deduplica por payment.id; nota/atividade não repetem mais em regra nova.
    expect(container.textContent).toMatch(/id da cobrança \(payment\.id\)/);
    expect(container.textContent).toMatch(/inclusive para nota e atividade/);
    expect(container.textContent).toMatch(/Regra criada antes desta versão.*payment\.id/);
    expect(container.textContent).toMatch(/ainda geram uma repetição de nota\/atividade/);
    expect(container.textContent).toMatch(/Deixar só PAYMENT_RECEIVED atrasa o cartão/);
    expect(container.textContent).not.toMatch(/para evitar, deixe só PAYMENT_RECEIVED/);
    expect(container.textContent).toMatch(/segunda condição em payment\.billingType/);
    expect(container.textContent).not.toMatch(/não consegue (separar|filtrar)/);
  });

  it.each(["stripe_checkout", "asaas_payment", "hotmart_purchase", "custom"] as const)(
    "%s: 200 ignorado para gateway e 400 para sistema próprio",
    (id) => {
      render(<InboundRuleHelp presetId={id} />);
      const list = screen.getByLabelText("Respostas da URL").textContent ?? "";
      expect(list).toMatch(
        /Stripe, Asaas e Hotmart.*sem o id.*JSON inválido.*ignorado.*contador de ignorados/,
      );
      expect(list).toMatch(/400.*sistema próprio \(HMAC\)/);
    },
  );

  it("Stripe explica o caminho alternativo, o id da sessão e que regra antiga não muda", () => {
    const { container } = render(<InboundRuleHelp presetId="stripe_checkout" />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/caminho alternativo data\.object\.customer_email/);
    expect(text).toMatch(/id da sessão de checkout \(data\.object\.id\)/);
    expect(text).toMatch(/Regra criada antes desta versão do modelo não muda sozinha/);
  });

  it("Hotmart ensina telefone por data.buyer.checkout_phone com prefixo 55 e mantém o id do evento", () => {
    const { container } = render(<InboundRuleHelp presetId="hotmart_purchase" />);
    const text = container.textContent ?? "";
    expect(text).toMatch(
      /escolha Telefone, use o caminho data\.buyer\.checkout_phone \(DDD \+ número/,
    );
    expect(text).toMatch(/sem DDI/);
    expect(text).toMatch(/Prefixo do país \(opcional\)" com 55/);
    expect(text).toMatch(/Não use data\.buyer\.checkout_phone_code/);
    expect(text).toMatch(/O campo data\.buyer\.phone não existe/);
    expect(text).toMatch(/Não troque por data\.purchase\.transaction/);
    expect(text).not.toMatch(/(use|usar|escolha)[^.]*data\.purchase\.transaction como/i);
  });

  it("explica quais status reprocessam no reenvio", () => {
    const { container } = render(<InboundRuleHelp presetId="custom" />);
    expect(container.textContent).toMatch(
      /exceto quando ele falhou, bateu no limite, não\s+encontrou o negócio, achou mais de um ou foi ignorado porque as condições não casaram/,
    );
  });

  it("Personalizado mostra o exemplo de assinatura; gateway com token próprio não", () => {
    const { unmount } = render(<InboundRuleHelp presetId="custom" />);
    expect(screen.getByLabelText("Exemplo de assinatura em Node").textContent).toContain(
      "X-Aceleraflow-Signature",
    );
    unmount();
    render(<InboundRuleHelp presetId="asaas_payment" />);
    expect(screen.queryByLabelText("Exemplo de assinatura em Node")).toBeNull();
    expect(screen.getByText(/asaas-access-token/)).toBeTruthy();
  });

  // Overflow real não é medível em jsdom: as classes são o contrato.
  it("exemplo de assinatura rola na horizontal sem alargar o diálogo", () => {
    render(<InboundRuleHelp presetId="custom" />);
    const pre = screen.getByLabelText("Exemplo de assinatura em Node");
    expect(pre.className).toContain("overflow-x-auto");
    expect(pre.className).toContain("min-w-0");
    expect(pre.className).toContain("max-w-full");
  });
});
