#!/usr/bin/env node
// Gate de drift nos pins de seguranca de dependencia, nas duas pontas da cadeia:
//
//   pnpm-workspace.yaml (SSOT, `overrides:`) -> package.json (`overrides`, espelho
//   manual que o `bun install` da Lovable le) -> bun.lock (versao de fato resolvida,
//   o lockfile que o deploy usa).
//
// O bot da Lovable reescreve `package.json` e `bun.lock` direto na main sem passar
// por review. Ele pode desfazer qualquer um dos dois elos em silencio: bumpar
// `bun.lock` sem tocar o pin (elo 2), ou reescrever `package.json` e apagar/encurtar
// o espelho do pin da SSOT (elo 1) — os dois ficam invisiveis para o Dependabot, que
// so le `pnpm-lock.yaml`. Historico: PR #210 (pin declarado so no papel, versao
// vulneravel no ar apesar do alerta do GitHub aparecer fechado).
//
// Nao cobre o pin `pnpm-workspace.yaml` -> `pnpm-lock.yaml`: esse o Dependabot ja le,
// e o `pnpm install --frozen-lockfile` do CI reprova sozinho se divergir.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , packageJsonArg, bunLockArg, workspaceYamlArg] = process.argv;
const packageJsonPath = resolve(packageJsonArg ?? "package.json");
const bunLockPath = resolve(bunLockArg ?? "bun.lock");
const workspaceYamlPath = resolve(workspaceYamlArg ?? "pnpm-workspace.yaml");

/**
 * Extrai o bloco `overrides:` (mapa achatado, uma versao por linha) de
 * pnpm-workspace.yaml. Chave pode vir entre aspas simples (`'@hono/node-server'`).
 * Nao e um parser de YAML geral — cobre so esse formato, que e o unico usado aqui.
 */
function parseOverridesBlock(yamlText) {
  const lines = yamlText.split("\n");
  const startIndex = lines.findIndex((line) => /^overrides:\s*$/.test(line));
  if (startIndex === -1) return {};

  const pins = {};
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // dedentou: o bloco `overrides` acabou
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^'([^']+)'\s*:\s*(.+)$/) ?? trimmed.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    pins[match[1].trim()] = match[2].trim();
  }
  return pins;
}

/** bun.lock e JSONC (permite virgula sobrando antes de `}`/`]`); sem comentarios no repo. */
function parseBunLock(raw) {
  return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
}

/** Compara versoes numericas ponto-a-ponto; segmento faltante conta como 0. */
function isBehind(resolvedVersion, requiredVersion) {
  const a = resolvedVersion.split(".").map((p) => parseInt(p, 10) || 0);
  const b = requiredVersion.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Converte o seletor do pnpm no nome que npm/bun usam como chave.
 * O pnpm aceita `pacote@major` (`hono@4`); o formato de `overrides` do npm/bun nao
 * aceita esse sufixo, a chave la e o nome puro. `@` na posicao 0 e escopo, nao versao:
 * `@hono/node-server` fica intacto, `hono@4` vira `hono`, `@types/node@20` vira
 * `@types/node`.
 */
function bareName(selector) {
  const at = selector.lastIndexOf("@");
  return at > 0 ? selector.slice(0, at) : selector;
}

function main() {
  const ssotPins = parseOverridesBlock(readFileSync(workspaceYamlPath, "utf8"));
  // `brace-expansion` fica de fora do espelho de proposito: precisa de dois pins por
  // major (1.x e 5.x) e o bun nao suporta overrides aninhados por major — mirar
  // forcaria as duas arvores pra mesma versao e quebraria o build. Exclusao by design,
  // nao falta de sincronismo.
  const ssotNames = Object.keys(ssotPins).filter((name) => bareName(name) !== "brace-expansion");

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const mirrorPins = packageJson.overrides ?? {};
  const mirrorNames = Object.keys(mirrorPins);

  const drift = [];

  // Dois seletores do pnpm que colapsam no mesmo nome puro (ex.: `pkg@1` e `pkg@5`) nao
  // cabem numa unica chave do npm/bun. E o caso do `brace-expansion`, ja excluido acima;
  // qualquer novo precisa de decisao explicita, nao de comparacao silenciosa contra um so.
  const bySpelledName = new Map();
  for (const name of ssotNames) {
    const bare = bareName(name);
    bySpelledName.set(bare, [...(bySpelledName.get(bare) ?? []), name]);
  }
  for (const [bare, selectors] of bySpelledName) {
    if (selectors.length > 1) {
      drift.push(
        `${bare}: ${selectors.length} pins por major (${selectors.join(", ")}) nao cabem numa chave de package.json > overrides — decida o espelho e adicione a excecao no script`,
      );
    }
  }

  // Elo 1: todo pin da SSOT precisa estar espelhado (e em dia) em package.json.
  for (const name of ssotNames) {
    const required = ssotPins[name];
    const bare = bareName(name);
    const mirrored = mirrorPins[bare];
    if (!mirrored) {
      drift.push(
        `${name}: ausente em package.json > overrides (chave esperada "${bare}"; pnpm-workspace.yaml exige >= ${required})`,
      );
    } else if (isBehind(mirrored, required)) {
      drift.push(
        `${name}: package.json > overrides tem ${mirrored}, pnpm-workspace.yaml exige >= ${required}`,
      );
    }
  }

  // Elo 2: bun.lock precisa ter de fato resolvido a versao que package.json exige.
  if (mirrorNames.length > 0) {
    const bunLock = parseBunLock(readFileSync(bunLockPath, "utf8"));
    const packages = bunLock.packages ?? {};
    for (const name of mirrorNames) {
      const requiredVersion = mirrorPins[name];
      const entry = packages[name];
      if (!entry) {
        drift.push(`${name}: ausente em bun.lock (esperado >= ${requiredVersion})`);
        continue;
      }
      const resolvedVersion = entry[0].slice(name.length + 1);
      if (isBehind(resolvedVersion, requiredVersion)) {
        drift.push(
          `${name}: bun.lock resolve ${resolvedVersion}, package.json exige >= ${requiredVersion}`,
        );
      }
    }
  }

  if (drift.length > 0) {
    console.error("check-lockfile-pins: drift nos pins de seguranca de dependencia:");
    for (const line of drift) console.error(`  - ${line}`);
    console.error(
      "Corrija espelhando o pin que falta/ficou atras em package.json > overrides e rodando " +
        "`bun install` (regrava bun.lock respeitando os overrides); depois commite o resultado.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `check-lockfile-pins: ${ssotNames.length} pin(s) da SSOT espelhado(s) e ${mirrorNames.length} ` +
      "override(s) resolvido(s) em bun.lock — tudo em dia.",
  );
}

try {
  main();
} catch (error) {
  console.error(
    "check-lockfile-pins: falhou ao rodar o check —",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}
