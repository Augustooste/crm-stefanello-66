import { describe, expect, it } from "vitest";

import { BASE_ASSUMPTIONS, computeBusinessCase } from "./business-case";
import { buildProposalSections, proposalRejectReason } from "./proposal-draft";

const MEETING = {
  title: "Reunião de diagnóstico comercial",
  summary:
    "A Atlas Industrial relatou dependência de atualizações manuais no CRM, com registros que podem ocorrer no fim do dia ou no dia seguinte.",
  painPoints: ["A atualização das oportunidades no CRM ainda depende bastante dos vendedores."],
  objections: ["Receio de adicionar tecnologia que gere mais trabalho para os vendedores."],
  priorities: ["Reduzir atividades administrativas."],
  nextSteps: ["Mapear o fluxo comercial atual."],
};

describe("proposalRejectReason", () => {
  it("bloqueia tecnologia inventada", () => {
    expect(proposalRejectReason("Integração com Salesforce e SAP.")).toBe("tecnologia:sap");
    expect(proposalRejectReason("Conectar ao Outlook.")).toBe("tecnologia:outlook");
  });
  it("bloqueia número, ROI e valor", () => {
    expect(proposalRejectReason("ROI de 300% em 6 meses.")).toBe("numero");
    expect(proposalRejectReason("Investimento de R$ 250.000.")).toBe("numero");
    expect(proposalRejectReason("Economia de 30 horas por semana.")).toBe("numero");
    expect(proposalRejectReason("Retorno garantido com payback rápido.")).toBe("proibido:payback");
  });
  it("bloqueia orçamento aprovado e atribuição de pedido", () => {
    expect(proposalRejectReason("Com o orçamento aprovado, seguimos.")).toBe("proibido:orcamento");
    expect(proposalRejectReason("Conforme solicitado pela Mariana.")).toBe("proibido:solicit");
    expect(proposalRejectReason("Como combinado, segue a proposta.")).toBe(
      "proibido:como combinado",
    );
  });
  it("aceita o texto confirmado da reunião", () => {
    expect(proposalRejectReason(MEETING.summary)).toBeNull();
    expect(proposalRejectReason(MEETING.objections[0])).toBeNull();
  });
});

describe("buildProposalSections", () => {
  it("contexto e problemas vêm só da reunião gravada; linha inventada cai", () => {
    const s = buildProposalSections({
      ...MEETING,
      painPoints: [...MEETING.painPoints, "Perdem 30 horas por semana no Salesforce."],
    });
    expect(s.context).toEqual([MEETING.summary]);
    expect(s.problems).toEqual(MEETING.painPoints);
    expect(s.concerns).toEqual(MEETING.objections);
  });
  it("nenhuma seção fixa tem número, tecnologia ou compromisso", () => {
    const s = buildProposalSections(MEETING);
    for (const t of [
      ...s.objectives,
      ...s.scope,
      ...s.deliverables,
      ...s.howItWorks,
      ...s.nextSteps,
    ]) {
      expect(proposalRejectReason(t), t).toBeNull();
    }
    expect(s.nextSteps.join(" ")).not.toMatch(/assinar|contrato|kickoff|implanta/i);
  });
  it("sem reunião: seções de contexto vazias, sem inventar", () => {
    const s = buildProposalSections(null);
    expect(s.context).toEqual([]);
    expect(s.problems).toEqual([]);
  });
  it("texto da proposta não mexe nos números: ROI continua determinístico", () => {
    buildProposalSections({ ...MEETING, summary: "ROI de 300% e investimento de R$ 250.000." });
    const r = computeBusinessCase({ sellers: 12, investment: 180000, ...BASE_ASSUMPTIONS });
    expect(r.roi12mPercent).toBeCloseTo(-47.2, 1);
    expect(r.monthlySaving).toBe(7920);
  });
});
