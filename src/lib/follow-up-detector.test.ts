import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { detectFollowUpIntent } from "./follow-up-detector";

/**
 * `detectFollowUpIntent` usa `new Date()` (agora do relógio real) e
 * `setHours(9, 0, 0, 0)` (hora LOCAL do runner) — os testes fixam o relógio
 * com `vi.setSystemTime` e verificam deslocamento de dia/dia-da-semana
 * (`getDate`/`getDay`), nunca `toISOString()`, para não flakar num CI rodando
 * em UTC (ver PRD, riscos #9 — timezone é uma preocupação de fila/bounds,
 * não deste detector, que só usa hora local do processo).
 */
describe("detectFollowUpIntent", () => {
  beforeEach(() => {
    // Quarta-feira, 2026-07-08 12:00 local — dia fixo e conhecido para todos os testes.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 8, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retorna detected=false quando nenhuma frase bate", () => {
    // Nenhum dos padrões cobertos aparece aqui — heurística determinística,
    // não IA (PRD, riscos #7): frases fora do vocabulário coberto não disparam.
    const result = detectFollowUpIntent([
      "oi, tudo bem?",
      "quero saber mais sobre o produto antes de decidir qualquer coisa",
    ]);
    expect(result.detected).toBe(false);
    expect(result.phrases).toEqual([]);
    expect(result.suggestedDate).toBeNull();
    expect(result.confidence).toBe("low");
  });

  it("detecta 'dia 15' e agenda para o dia 15 deste mês (ainda não passou)", () => {
    const result = detectFollowUpIntent(["pode me ligar dia 15 por favor"]);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.suggestedDate?.getDate()).toBe(15);
    expect(result.suggestedDate?.getMonth()).toBe(6); // julho (mês corrente)
  });

  it("'dia 15' quando o dia já passou no mês vira dia 15 do mês seguinte", () => {
    vi.setSystemTime(new Date(2026, 6, 20, 12, 0, 0)); // 20/jul
    const result = detectFollowUpIntent(["me chama dia 15"]);
    expect(result.suggestedDate?.getDate()).toBe(15);
    expect(result.suggestedDate?.getMonth()).toBe(7); // agosto
  });

  it("detecta 'semana que vem' e agenda D+7", () => {
    const result = detectFollowUpIntent(["te chamo semana que vem"]);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe("high");
    expect(result.suggestedDate?.getDate()).toBe(15); // 8 + 7
  });

  it("detecta dia da semana ('sexta') e agenda a próxima ocorrência (nunca hoje)", () => {
    // hoje é quarta (getDay()=3); sexta é 5 -> +2 dias = dia 10
    const result = detectFollowUpIntent(["fala comigo sexta"]);
    expect(result.detected).toBe(true);
    expect(result.suggestedDate?.getDay()).toBe(5);
    expect(result.suggestedDate?.getDate()).toBe(10);
  });

  it("detecta dia da semana com acento e cedilha ('terça')", () => {
    const result = detectFollowUpIntent(["retorno terça"]);
    expect(result.detected).toBe(true);
    // "terça" (priority 7) vence "retorno" (priority 5)
    expect(result.suggestedDate?.getDay()).toBe(2);
  });

  it("dia da semana igual ao dia atual pula para a próxima semana (nunca 0 dias)", () => {
    // hoje é quarta (getDay()=3) — pedir "quarta" deve pular pra próxima quarta (+7)
    const result = detectFollowUpIntent(["combinamos quarta"]);
    expect(result.suggestedDate?.getDate()).toBe(15);
  });

  it("detecta 'retorno' e agenda D+3", () => {
    const result = detectFollowUpIntent(["vou retornar em breve"]);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe("medium");
    expect(result.suggestedDate?.getDate()).toBe(11);
  });

  it("detecta 'vou decidir' e agenda D+2", () => {
    const result = detectFollowUpIntent(["vou decidir e te aviso"]);
    expect(result.suggestedDate?.getDate()).toBe(10);
    expect(result.confidence).toBe("medium");
  });

  it("detecta 'me liga'/'me chama' e agenda D+1", () => {
    const result = detectFollowUpIntent(["me liga amanhã de manhã"]);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe("medium");
    expect(result.suggestedDate?.getDate()).toBe(9);
  });

  it("detecta 'depois'/'mais tarde' com confidence low e agenda D+1", () => {
    const result = detectFollowUpIntent(["falo com você depois"]);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe("low");
    expect(result.suggestedDate?.getDate()).toBe(9);
  });

  it("quando múltiplas frases batem, usa a de maior prioridade (mais específica)", () => {
    // "dia 20" (priority 10) deve vencer "me chama" (priority 6)
    const result = detectFollowUpIntent(["me chama, mas só no dia 20"]);
    expect(result.suggestedDate?.getDate()).toBe(20);
    expect(result.confidence).toBe("high");
    expect(result.phrases.length).toBeGreaterThanOrEqual(2);
  });

  it("junta mensagens de uma lista antes de detectar (combined join)", () => {
    const result = detectFollowUpIntent(["oi", "tudo bem", "me chama semana que vem"]);
    expect(result.detected).toBe(true);
    expect(result.suggestedDate?.getDate()).toBe(15);
  });
});
