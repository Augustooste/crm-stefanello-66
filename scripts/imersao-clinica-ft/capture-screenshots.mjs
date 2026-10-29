#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_BASE_URL,
  JOURNEY,
  VIEWPORT,
  assertionProfile,
  expectHealthyPage,
  requiredCredentials,
  safeError,
  signInClinica,
} from "../../e2e/imersao-clinica-ft/jornada-helpers.mjs";

// Sem --out, as telas vão para a pasta da apresentação e o relatório fica fora dela,
// junto das demais evidências; com --out explícito, ambos continuam no mesmo diretório.
const DEFAULT_OUT = "artifacts/imersao-clinica-ft/apresentacao/telas/";
const DEFAULT_REPORT_DIR = "artifacts/imersao-clinica-ft/screenshots/";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    profile: { type: "string", default: process.env.IMERSAO_PROFILE ?? "prod" },
    only: { type: "string" },
    viewport: { type: "string", default: "1440x900" },
  },
});
const profile = assertionProfile(values.profile);
const baseURL = process.env.IMERSAO_BASE_URL ?? DEFAULT_BASE_URL;
const viewport =
  values.viewport === "1440x900"
    ? VIEWPORT
    : values.viewport === "1920x1080"
      ? { width: 1920, height: 1080 }
      : null;
if (!viewport) throw new Error("Viewport inválido: use 1440x900 ou 1920x1080.");
const output = resolve(values.out ?? DEFAULT_OUT);
const reportDir = resolve(values.out ?? DEFAULT_REPORT_DIR);
const selected = [...JOURNEY.entries()].filter(
  ([, step]) => !values.only || step.name === values.only,
);
if (selected.length === 0) {
  throw new Error(`Etapa inválida para --only: ${values.only}.`);
}
const reportFilename = values.only ? `resultado-${values.only}.json` : "resultado.json";
const reportPath = resolve(reportDir, reportFilename);
requiredCredentials();

async function main() {
  await mkdir(output, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  // Uma recaptura seletiva preserva as outras evidências, inclusive as anteriores ao GIF.
  for (const [index, step] of selected) {
    await rm(resolve(output, `${String(index + 1).padStart(2, "0")}-${step.name}.png`), {
      force: true,
    });
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL, viewport, locale: "pt-BR" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const results = [];
  try {
    // Nenhuma gravação começa antes do término da autenticação.
    await signInClinica(page);
    for (const [index, step] of selected) {
      const filename = `${String(index + 1).padStart(2, "0")}-${step.name}.png`;
      try {
        await step.verify(page, profile);
        await expectHealthyPage(page);
        if (profile === "prod" && step.name === "dashboard") {
          await page
            .getByRole("heading", { name: "Performance da IA (revisão humana)", exact: true })
            .evaluate((element) =>
              element.scrollIntoView({ block: "center", behavior: "instant" }),
            );
        }
        await page.screenshot({ path: resolve(output, filename), fullPage: false });
        results.push({
          etapa: index + 1,
          titulo: step.title,
          arquivo: filename,
          resultado: "PASSOU",
          rota: new URL(page.url()).pathname,
        });
        console.log(`PASSOU ${filename} (${profile}, ${viewport.width}×${viewport.height}).`);
      } catch (error) {
        const reason = safeError(error);
        results.push({ etapa: index + 1, titulo: step.title, resultado: "FALHOU", motivo: reason });
        console.error(`FALHOU ${filename}: ${reason}`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          profile,
          baseURL,
          viewport,
          capturadoEm: new Date().toISOString(),
          somente: values.only ?? null,
          onboarding: "Estado aplicado; o wizard não foi reexecutado.",
          autenticacao: "Sem trace, vídeo, HAR, storageState em disco ou screenshot do login.",
          results,
        },
        null,
        2,
      )}\n`,
    );
  }
  const passed = results.filter((result) => result.resultado === "PASSOU").length;
  if (results.length !== selected.length || passed !== selected.length) {
    throw new Error(
      `Captura incompleta: ${passed}/${selected.length} telas válidas. Consulte ${reportPath}.`,
    );
  }
  console.log(`${passed}/${selected.length} telas verificadas no perfil ${profile}: ${output}`);
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
