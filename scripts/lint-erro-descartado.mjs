#!/usr/bin/env node
// Ratchet do "erro do Supabase descartado": reprova apenas ocorrências em linhas
// que a branch de fato escreveu.
//
// Granularidade por LINHA, não por arquivo, de propósito. O codebase tem ~50
// ocorrências herdadas, várias em arquivos de 2000+ linhas; reprovar por arquivo
// obrigaria quem encosta em `messaging-webhook` a limpar dívida alheia, e a regra
// seria desligada na primeira PR grande. O passivo segue rastreado como finding
// em docs/code-review; aqui só impedimos que cresça.
//
// Uso: node scripts/lint-erro-descartado.mjs [base]   (base padrão: origin/main)

import { execFileSync } from "node:child_process";

const base = process.argv[2] ?? "origin/main";
const ALVO = (f) => /^src\/.*\.tsx?$/.test(f) || /^supabase\/functions\/.*\.ts$/.test(f);

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

/** Linhas adicionadas/modificadas por arquivo, lidas do diff unificado sem contexto. */
function linhasEscritas(base) {
  let diff;
  try {
    diff = git(["diff", "-U0", "--diff-filter=d", `${base}...HEAD`]);
  } catch (e) {
    const motivo = String(e.stderr ?? e.message ?? "");
    if (motivo.includes("no merge base")) {
      // Aconteceu no CI em 10/08: actions/checkout usa depth 1 por padrão, então
      // o ancestral comum não existe no grafo local e o `...` não resolve.
      console.error(
        `Sem ancestral comum entre ${base} e HEAD.\n` +
          `No CI: use 'fetch-depth: 0' no actions/checkout.\n` +
          `Local: 'git fetch --unshallow origin' resolve.`,
      );
    } else {
      console.error(`Não consegui comparar com ${base}: ${motivo.trim()}`);
    }
    process.exit(1);
  }
  const porArquivo = new Map();
  let atual = null;
  for (const linha of diff.split("\n")) {
    const cabecalho = linha.match(/^\+\+\+ b\/(.+)$/);
    if (cabecalho) {
      atual = ALVO(cabecalho[1]) ? cabecalho[1] : null;
      if (atual) porArquivo.set(atual, new Set());
      continue;
    }
    const hunk = linha.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && atual) {
      const inicio = Number(hunk[1]);
      const quantas = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < quantas; i++) porArquivo.get(atual).add(inicio + i);
    }
  }
  return porArquivo;
}

const escritas = linhasEscritas(base);
if (escritas.size === 0) {
  console.log("Nenhum arquivo de código alterado — nada a checar.");
  process.exit(0);
}

let saida = "";
try {
  saida = execFileSync(
    "node",
    [
      "node_modules/eslint/bin/eslint.js",
      "--no-ignore",
      "--config",
      "eslint.erro-descartado.config.js",
      "--format",
      "json",
      ...escritas.keys(),
    ],
    { encoding: "utf8" },
  );
} catch (e) {
  // eslint sai com código 1 quando há erro; o JSON continua no stdout.
  saida = e.stdout ?? "";
}

const novos = [];
for (const arquivo of JSON.parse(saida || "[]")) {
  const relativo = arquivo.filePath.replace(`${process.cwd()}/`, "");
  const linhasDoArquivo = escritas.get(relativo);
  if (!linhasDoArquivo) continue;
  for (const m of arquivo.messages) {
    if (m.ruleId === "no-restricted-syntax" && linhasDoArquivo.has(m.line)) {
      novos.push({ relativo, linha: m.line, texto: m.message });
    }
  }
}

if (novos.length === 0) {
  const total = [...escritas.values()].reduce((s, l) => s + l.size, 0);
  console.log(
    `OK: ${escritas.size} arquivo(s), ${total} linha(s) nova(s), nenhuma escrita com retorno descartado.`,
  );
  process.exit(0);
}

console.error("Escrita do Supabase com o retorno descartado, em linha nova desta branch:\n");
for (const n of novos) console.error(`  ${n.relativo}:${n.linha}\n    ${n.texto}\n`);
console.error("supabase-js não lança: sem checar `error`, a falha vira sucesso silencioso.");
process.exit(1);
