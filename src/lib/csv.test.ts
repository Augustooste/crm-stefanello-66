import { describe, expect, it } from "vitest";
import { detectCsvDelimiter, parseCsv, stringifyCsv, withUtf8Bom } from "./csv";

describe("detectCsvDelimiter", () => {
  it("detecta vírgula quando é o delimitador dominante", () => {
    expect(detectCsvDelimiter("nome,email,telefone\nJoão,joao@x.com,123")).toBe(",");
  });

  it("detecta ponto-e-vírgula quando é o delimitador dominante", () => {
    expect(detectCsvDelimiter("nome;email;telefone\nJoão;joao@x.com;123")).toBe(";");
  });

  it("detecta tab quando é o delimitador dominante", () => {
    expect(detectCsvDelimiter("nome\temail\ttelefone")).toBe("\t");
  });

  it("prefere ; em caso de empate com , (Excel pt-BR)", () => {
    // 1 vírgula, 1 ponto-e-vírgula -> empate -> prefere ;
    expect(detectCsvDelimiter("a,b;c")).toBe(";");
  });

  it("usa apenas a primeira linha da amostra", () => {
    expect(detectCsvDelimiter("a,b,c\nd;e;f;g;h")).toBe(",");
  });

  it("faz fallback para vírgula quando não há nenhum delimitador", () => {
    expect(detectCsvDelimiter("apenasumacoluna")).toBe(",");
  });

  it("trata entrada vazia/nula com segurança", () => {
    expect(detectCsvDelimiter("")).toBe(",");
  });
});

describe("parseCsv", () => {
  it("faz parse de headers e linhas simples", () => {
    const { headers, rows } = parseCsv("nome,email\nJoão,joao@x.com\nMaria,maria@x.com", ",");
    expect(headers).toEqual(["nome", "email"]);
    expect(rows).toEqual([
      ["João", "joao@x.com"],
      ["Maria", "maria@x.com"],
    ]);
  });

  it("faz parse com delimitador ponto-e-vírgula", () => {
    const { headers, rows } = parseCsv("nome;idade\nJoão;30", ";");
    expect(headers).toEqual(["nome", "idade"]);
    expect(rows).toEqual([["João", "30"]]);
  });

  it("trata campos entre aspas contendo o delimitador", () => {
    const { rows } = parseCsv('nome,endereco\nJoão,"Rua A, 123"', ",");
    expect(rows).toEqual([["João", "Rua A, 123"]]);
  });

  it("trata aspas escapadas dentro de campo entre aspas", () => {
    const { rows } = parseCsv('nome,apelido\nJoão,"O ""Joãozinho"""', ",");
    expect(rows).toEqual([["João", 'O "Joãozinho"']]);
  });

  it("trata campos entre aspas com quebra de linha embutida", () => {
    const { rows } = parseCsv('nome,bio\nJoão,"linha1\nlinha2"', ",");
    expect(rows).toEqual([["João", "linha1\nlinha2"]]);
  });

  it("é tolerante a CRLF", () => {
    const { headers, rows } = parseCsv("nome,email\r\nJoão,joao@x.com\r\nMaria,maria@x.com", ",");
    expect(headers).toEqual(["nome", "email"]);
    expect(rows).toEqual([
      ["João", "joao@x.com"],
      ["Maria", "maria@x.com"],
    ]);
  });

  it("é tolerante a LF puro", () => {
    const { rows } = parseCsv("nome,email\nJoão,joao@x.com\n", ",");
    expect(rows).toEqual([["João", "joao@x.com"]]);
  });

  it("remove BOM UTF-8 do início do texto", () => {
    const { headers } = parseCsv("﻿nome,email\nJoão,joao@x.com", ",");
    expect(headers).toEqual(["nome", "email"]);
  });

  it("descarta linhas completamente vazias", () => {
    const { rows } = parseCsv("nome,email\nJoão,joao@x.com\n\n,\n", ",");
    expect(rows).toEqual([["João", "joao@x.com"]]);
  });

  it("faz trim dos headers", () => {
    const { headers } = parseCsv(" nome , email \nJoão,joao@x.com", ",");
    expect(headers).toEqual(["nome", "email"]);
  });

  it("trata entrada vazia sem lançar erro", () => {
    const { headers, rows } = parseCsv("", ",");
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });
});

describe("stringifyCsv", () => {
  it("serializa linhas simples com vírgula", () => {
    expect(
      stringifyCsv([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe("a,b\nc,d");
  });

  it("serializa com delimitador customizado", () => {
    expect(stringifyCsv([["a", "b"]], ";")).toBe("a;b");
  });

  it("coloca entre aspas células contendo o delimitador", () => {
    expect(stringifyCsv([["Rua A, 123", "b"]], ",")).toBe('"Rua A, 123",b');
  });

  it("coloca entre aspas e escapa células contendo aspas", () => {
    expect(stringifyCsv([['O "Joãozinho"']])).toBe('"O ""Joãozinho"""');
  });

  it("coloca entre aspas células contendo quebra de linha", () => {
    expect(stringifyCsv([["linha1\nlinha2"]])).toBe('"linha1\nlinha2"');
  });

  describe("proteção contra CSV formula injection (OWASP)", () => {
    it("prefixa célula iniciando com = com aspa simples", () => {
      expect(stringifyCsv([["=SOMA(A1:A2)"]])).toBe("'=SOMA(A1:A2)");
    });

    it("prefixa célula iniciando com + com aspa simples", () => {
      expect(stringifyCsv([["+cmd|calc!A1"]])).toBe("'+cmd|calc!A1");
    });

    it("prefixa célula iniciando com - (não numérica) com aspa simples", () => {
      expect(stringifyCsv([["-cmd"]])).toBe("'-cmd");
    });

    it("prefixa célula iniciando com @ com aspa simples", () => {
      expect(stringifyCsv([["@SUM(1+1)"]])).toBe("'@SUM(1+1)");
    });

    it("NÃO prefixa valores numéricos negativos", () => {
      expect(stringifyCsv([["-12.5"]])).toBe("-12.5");
    });

    it("NÃO prefixa telefones com + (heurística numérica/telefone)", () => {
      expect(stringifyCsv([["+5511999990000"]])).toBe("+5511999990000");
    });

    it("NÃO prefixa quando escapeFormulas=false (transporte máquina-a-máquina)", () => {
      expect(stringifyCsv([["=SOMA(A1:A2)"]], ",", { escapeFormulas: false })).toBe("=SOMA(A1:A2)");
    });
  });

  it("trata array de linhas vazio", () => {
    expect(stringifyCsv([])).toBe("");
  });
});

describe("withUtf8Bom", () => {
  it("prefixa o texto com o BOM UTF-8", () => {
    expect(withUtf8Bom("nome,email")).toBe("﻿nome,email");
  });

  it("trata entrada nula/indefinida com segurança", () => {
    expect(withUtf8Bom(undefined as unknown as string)).toBe("﻿");
  });
});

describe("round-trip parseCsv <-> stringifyCsv", () => {
  it("preserva dados através de stringify -> parse", () => {
    const original = [
      ["nome", "endereco", "obs"],
      ["João", "Rua A, 123", 'linha1\nlinha2 com "aspas"'],
    ];
    const csvText = stringifyCsv(original, ",", { escapeFormulas: false });
    const { headers, rows } = parseCsv(csvText, ",");
    expect(headers).toEqual(original[0]);
    expect(rows).toEqual([original[1]]);
  });
});
