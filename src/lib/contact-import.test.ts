import { describe, expect, it } from "vitest";
import {
  buildContactHeaderMapping,
  decideContactRowAction,
  decideContactRowActions,
  normalizePhoneKey,
  parseContactRows,
} from "./contact-import";

describe("buildContactHeaderMapping", () => {
  it("reconhece sinônimos em PT-BR", () => {
    const { mapping, ignoredHeaders } = buildContactHeaderMapping([
      "nome",
      "telefone",
      "email",
      "tags",
      "notas",
    ]);
    expect(mapping).toEqual({ name: 0, phone: 1, email: 2, tags: 3, notes: 4 });
    expect(ignoredHeaders).toEqual([]);
  });

  it("reconhece sinônimos em EN", () => {
    const { mapping } = buildContactHeaderMapping(["name", "phone", "email", "tags", "notes"]);
    expect(mapping).toEqual({ name: 0, phone: 1, email: 2, tags: 3, notes: 4 });
  });

  it("reconhece variações acentuadas/maiúsculas", () => {
    const { mapping } = buildContactHeaderMapping(["Nome Completo", "TELEFONE", "E-mail"]);
    expect(mapping).toEqual({ name: 0, phone: 1, email: 2 });
  });

  it("lista colunas sem sinônimo reconhecido como ignoradas, nunca inventa campo", () => {
    const { mapping, ignoredHeaders } = buildContactHeaderMapping([
      "nome",
      "convenio",
      "procedimento",
    ]);
    expect(mapping).toEqual({ name: 0 });
    expect(ignoredHeaders).toEqual(["convenio", "procedimento"]);
  });

  it("reconhece coluna stage/etapa mas não a inclui como campo gravável (sem coluna de destino)", () => {
    const { mapping, ignoredHeaders, stageHeaderDetected } = buildContactHeaderMapping([
      "nome",
      "estagio",
    ]);
    expect(mapping.stage).toBe(1);
    expect(stageHeaderDetected).toBe(true);
    // stage nunca aparece em ignoredHeaders (foi reconhecida) nem é column real gravada
    expect(ignoredHeaders).toEqual([]);
  });

  it("stageHeaderDetected é false quando não há coluna stage/etapa", () => {
    const { stageHeaderDetected } = buildContactHeaderMapping(["nome", "telefone"]);
    expect(stageHeaderDetected).toBe(false);
  });
});

describe("parseContactRows", () => {
  const mapping = { name: 0, phone: 1, email: 2, tags: 3, notes: 4 };

  it("faz parse de linhas válidas com rowNumber 1-indexado (header=1)", () => {
    const { parsed, errors } = parseContactRows(mapping, [
      ["João Silva", "11999998888", "joao@x.com", "Quente,VIP", "Cliente antigo"],
      ["Maria", "", "maria@x.com", "", ""],
    ]);
    expect(errors).toEqual([]);
    expect(parsed).toEqual([
      {
        rowNumber: 2,
        name: "João Silva",
        phone: "11999998888",
        email: "joao@x.com",
        tags: ["Quente", "VIP"],
        notes: "Cliente antigo",
      },
      { rowNumber: 3, name: "Maria", phone: null, email: "maria@x.com", tags: [], notes: null },
    ]);
  });

  it("reporta linha sem nome e sem telefone como erro, sem travar as demais", () => {
    const { parsed, errors } = parseContactRows(mapping, [
      ["", "", "semnada@x.com", "", ""],
      ["João", "", "", "", ""],
    ]);
    expect(errors).toEqual([
      { linha: 2, motivo: "Linha sem nome e sem telefone (não é possível criar contato)." },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("João");
  });

  it("aceita linha com telefone mas sem nome", () => {
    const { parsed, errors } = parseContactRows(mapping, [["", "11999998888", "", "", ""]]);
    expect(errors).toEqual([]);
    expect(parsed).toEqual([
      { rowNumber: 2, name: null, phone: "11999998888", email: null, tags: [], notes: null },
    ]);
  });

  it("faz split de tags por vírgula, ponto-e-vírgula ou pipe", () => {
    const { parsed } = parseContactRows(mapping, [["João", "1", "", "Quente;VIP|Indicação", ""]]);
    expect(parsed[0].tags).toEqual(["Quente", "VIP", "Indicação"]);
  });
});

describe("normalizePhoneKey", () => {
  it("extrai apenas dígitos", () => {
    expect(normalizePhoneKey("(11) 99999-8888")).toBe("11999998888");
  });

  it("retorna null para telefone vazio/nulo", () => {
    expect(normalizePhoneKey("")).toBeNull();
    expect(normalizePhoneKey(null)).toBeNull();
    expect(normalizePhoneKey(undefined)).toBeNull();
  });

  it("retorna null quando não há nenhum dígito", () => {
    expect(normalizePhoneKey("---")).toBeNull();
  });
});

describe("decideContactRowAction", () => {
  it("criar_apenas sempre cria, mesmo com telefone duplicado", () => {
    const existing = new Map([["11999998888", ["contact-1"]]]);
    expect(decideContactRowAction("criar_apenas", { phone: "11999998888" }, existing)).toEqual({
      type: "create",
    });
  });

  it("upsert_por_telefone cria quando telefone não existe", () => {
    const existing = new Map<string, string[]>();
    expect(
      decideContactRowAction("upsert_por_telefone", { phone: "11999998888" }, existing),
    ).toEqual({
      type: "create",
    });
  });

  it("upsert_por_telefone atualiza quando telefone bate com exatamente 1 contato", () => {
    const existing = new Map([["11999998888", ["contact-1"]]]);
    expect(
      decideContactRowAction("upsert_por_telefone", { phone: "(11) 99999-8888" }, existing),
    ).toEqual({ type: "update", contactId: "contact-1" });
  });

  it("upsert_por_telefone marca como skip ambíguo quando há >1 contato com o mesmo telefone", () => {
    const existing = new Map([["11999998888", ["contact-1", "contact-2"]]]);
    const action = decideContactRowAction(
      "upsert_por_telefone",
      { phone: "11999998888" },
      existing,
    );
    expect(action.type).toBe("skip");
    expect((action as { motivo: string }).motivo).toContain("ambíguo");
  });

  it("pular_duplicados ignora linha cujo telefone já existe", () => {
    const existing = new Map([["11999998888", ["contact-1"]]]);
    expect(decideContactRowAction("pular_duplicados", { phone: "11999998888" }, existing)).toEqual({
      type: "skip",
      motivo: "Telefone já existe na base.",
    });
  });

  it("pular_duplicados cria quando telefone não existe", () => {
    const existing = new Map<string, string[]>();
    expect(decideContactRowAction("pular_duplicados", { phone: "11999998888" }, existing)).toEqual({
      type: "create",
    });
  });

  it("linha sem telefone sempre cria (sem chave de deduplicação), em qualquer modo", () => {
    const existing = new Map<string, string[]>();
    expect(decideContactRowAction("upsert_por_telefone", { phone: null }, existing)).toEqual({
      type: "create",
    });
    expect(decideContactRowAction("pular_duplicados", { phone: null }, existing)).toEqual({
      type: "create",
    });
  });
});

describe("decideContactRowActions (dedup dentro do proprio arquivo)", () => {
  it("pular_duplicados: 2 linhas com o mesmo telefone novo (fora do banco) -- so a primeira cria", () => {
    const existing = new Map<string, string[]>();
    const rows = [{ phone: "11999998888" }, { phone: "(11) 99999-8888" }];
    const actions = decideContactRowActions("pular_duplicados", rows, existing);
    expect(actions[0]).toEqual({ type: "create" });
    expect(actions[1].type).toBe("skip");
  });

  it("upsert_por_telefone: 2 linhas com o mesmo telefone novo -- so a primeira cria, segunda nao vira duplicata", () => {
    const existing = new Map<string, string[]>();
    const rows = [{ phone: "11999998888" }, { phone: "11999998888" }, { phone: "11999998888" }];
    const actions = decideContactRowActions("upsert_por_telefone", rows, existing);
    expect(actions[0]).toEqual({ type: "create" });
    expect(actions[1].type).toBe("skip");
    expect(actions[2].type).toBe("skip");
  });

  it("criar_apenas: mantem semantica de sempre criar, mesmo com telefone repetido no arquivo", () => {
    const existing = new Map<string, string[]>();
    const rows = [{ phone: "11999998888" }, { phone: "11999998888" }];
    const actions = decideContactRowActions("criar_apenas", rows, existing);
    expect(actions).toEqual([{ type: "create" }, { type: "create" }]);
  });

  it("telefone ja existente no banco continua sendo update/skip normal (nao e afetado pelo guard de arquivo)", () => {
    const existing = new Map<string, string[]>([["11999998888", ["contact-1"]]]);
    const rows = [{ phone: "11999998888" }];
    const actions = decideContactRowActions("upsert_por_telefone", rows, existing);
    expect(actions[0]).toEqual({ type: "update", contactId: "contact-1" });
  });

  it("linhas sem telefone nunca sao afetadas pelo guard de arquivo -- todas criam", () => {
    const existing = new Map<string, string[]>();
    const rows = [{ phone: null }, { phone: null }];
    const actions = decideContactRowActions("pular_duplicados", rows, existing);
    expect(actions).toEqual([{ type: "create" }, { type: "create" }]);
  });
});
