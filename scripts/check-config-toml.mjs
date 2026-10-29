#!/usr/bin/env node
// Valida supabase/config.toml sem dependência nenhuma (roda no job `lint`,
// antes do install).
//
// Por que existe: `verify_jwt` é a única linha do repositório que decide se uma
// edge function aceita chamada anônima. O arquivo é regravado em reconexão do
// Supabase, e um bloco perdido no meio de um merge não quebra build nem teste —
// só abre a function. Aqui a omissão vira erro de CI.
//
// Regras:
//   1. todo bloco [functions.<nome>] declara `verify_jwt` explicitamente;
//   2. o <nome> existe em supabase/functions/;
//   3. `project_id` está presente (o resto do tooling deriva dele).
//
// A cobertura de COMPORTAMENTO das functions com verify_jwt = false fica em
// supabase/functions/tests/config-jwt-contract.test.ts, que lê o mesmo arquivo.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caminhoConfig = path.join(raiz, "supabase", "config.toml");
const dirFunctions = path.join(raiz, "supabase", "functions");

const erros = [];

if (!existsSync(caminhoConfig)) {
  console.error("::error::supabase/config.toml não existe.");
  process.exit(1);
}

const conteudo = readFileSync(caminhoConfig, "utf8");
const linhas = conteudo.split("\n");

if (!/^\s*project_id\s*=/m.test(conteudo)) {
  erros.push("`project_id` ausente em supabase/config.toml.");
}

const functionsNoDisco = existsSync(dirFunctions)
  ? new Set(
      readdirSync(dirFunctions, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("_") && e.name !== "tests")
        .map((e) => e.name),
    )
  : new Set();

/** @type {{nome: string, verifyJwt: boolean | null, linha: number}[]} */
const blocos = [];
let atual = null;

linhas.forEach((linha, indice) => {
  const semComentario = linha.replace(/#.*$/, "");
  const cabecalho = semComentario.match(/^\s*\[([^\]]+)\]\s*$/);
  if (cabecalho) {
    const secao = cabecalho[1].trim();
    if (secao.startsWith("functions.")) {
      atual = { nome: secao.slice("functions.".length), verifyJwt: null, linha: indice + 1 };
      blocos.push(atual);
    } else {
      atual = null;
    }
    return;
  }
  if (!atual) return;
  const flag = semComentario.match(/^\s*verify_jwt\s*=\s*(true|false)\s*$/);
  if (flag) atual.verifyJwt = flag[1] === "true";
});

for (const bloco of blocos) {
  if (bloco.verifyJwt === null) {
    erros.push(
      `[functions.${bloco.nome}] (linha ${bloco.linha}) não declara \`verify_jwt\`. ` +
        "Declare explicitamente — o default silencioso é o que abre function por acidente.",
    );
  }
  if (functionsNoDisco.size > 0 && !functionsNoDisco.has(bloco.nome)) {
    erros.push(
      `[functions.${bloco.nome}] (linha ${bloco.linha}) não corresponde a nenhuma pasta em ` +
        "supabase/functions/. Bloco órfão: renomeie ou remova.",
    );
  }
}

const publicas = blocos.filter((b) => b.verifyJwt === false).map((b) => b.nome);

if (erros.length > 0) {
  for (const erro of erros) console.error(`::error::${erro}`);
  process.exit(1);
}

console.log(
  `config.toml OK — ${blocos.length} bloco(s) de function, ` +
    `${publicas.length} sem verificação de JWT: ${publicas.join(", ") || "(nenhuma)"}.`,
);
