#!/usr/bin/env node

import { chromium, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  VIEWPORT,
  expectHealthyPage,
  openPage,
  requiredCredentials,
  safeError,
  signInClinica,
} from "../../e2e/imersao-clinica-ft/jornada-helpers.mjs";

const baseURL = process.env.IMERSAO_BASE_URL;
if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error(
    "O GIF executa uma prova com escrita: IMERSAO_BASE_URL deve apontar para o frontend local.",
  );
}
const target = {
  tenantId: process.env.IMERSAO_TENANT_ID,
  boardId: process.env.IMERSAO_BOARD_ID,
  dealId: process.env.IMERSAO_DEAL_ID,
  targetStageId: process.env.IMERSAO_TARGET_STAGE_ID,
};
for (const [name, value] of Object.entries(target)) {
  if (name === "targetStageId" && !value) continue;
  if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Alvo inválido ou ausente: ${name}. Informe tenant, board e deal existentes.`);
  }
}
requiredCredentials();
const artifactDir = resolve("artifacts/imersao-clinica-ft");
const gifPath = join(artifactDir, "kanban-auto.gif");
const proofPath = resolve(
  process.env.IMERSAO_PROOF_OUTPUT || join(artifactDir, "kanban-auto-proof.json"),
);
const evidencePath = join(artifactDir, "kanban-auto.json");

function startProcess(command, args, timeout) {
  // A saída do worker/ffmpeg não é propagada: pode incluir headers ou ambiente em falhas.
  const child = spawn(command, args, { stdio: "ignore", env: process.env, timeout });
  const completion = new Promise((resolveExit, reject) => {
    child.once("error", () => reject(new Error(`Não foi possível iniciar ${command}.`)));
    child.once("close", (code, signal) => {
      if (code === 0) resolveExit();
      else
        reject(
          new Error(
            `${command} encerrou com código ${code ?? "ausente"}${signal ? ` (${signal})` : ""}.`,
          ),
        );
    });
  });
  // O comando roda em paralelo aos frames; uma rejeição antecipada não fica sem handler.
  void completion.catch(() => {});
  return { child, completion };
}

function sampleFrames(frames, limit) {
  if (frames.length <= limit) return frames;
  return Array.from(
    { length: limit },
    (_, index) => frames[Math.round((index * (frames.length - 1)) / (limit - 1))],
  );
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([gifPath, proofPath, evidencePath].map((path) => rm(path, { force: true })));
  const framesDir = await mkdtemp(join(tmpdir(), "imersao-kanban-"));
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL, viewport: VIEWPORT, locale: "pt-BR" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const frames = [];
  let recording = false;
  let captureError;
  let capture;
  let proof;
  try {
    await signInClinica(page);
    await openPage(page, `/pipeline?dealId=${target.dealId}`);
    const card = page.locator(`[data-deal-id="${target.dealId}"]`);
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await expectHealthyPage(page);
    const column = () => page.getByTestId("pipeline-column").filter({ has: card });
    const beforeId = await column().getAttribute("data-stage-id");
    const beforeName = await column().getAttribute("data-stage-name");
    if (!beforeId || !beforeName)
      throw new Error("Não foi possível ler a coluna inicial do negócio.");

    const startedAt = Date.now();
    recording = true;
    capture = (async () => {
      while (recording) {
        if (Date.now() - startedAt > 180_000)
          throw new Error("A gravação excedeu 180 segundos sem prova completa.");
        // Uma sessão expirada nunca vira frame da autenticação.
        if (/\/(auth|onboarding)(?:[/?#]|$)/.test(new URL(page.url()).pathname)) {
          throw new Error("Gravação interrompida: a página saiu da área autenticada.");
        }
        await expect(page.locator('input[type="password"]')).toHaveCount(0);
        const filename = join(framesDir, `frame-${String(frames.length).padStart(5, "0")}.png`);
        await page.screenshot({ path: filename });
        frames.push(filename);
        await delay(125);
      }
    })().catch((error) => {
      captureError = error;
      recording = false;
    });
    await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(8);
    const triggerFrame = frames.length;
    const args = [
      "scripts/imersao-clinica-ft/local-pipeline-agent-proof.mjs",
      "--tenant-id",
      target.tenantId,
      "--board-id",
      target.boardId,
      "--deal-id",
      target.dealId,
      "--output",
      proofPath,
    ];
    if (target.targetStageId) args.push("--target-stage-id", target.targetStageId);
    proof = startProcess(process.execPath, args, 160_000);

    // usePipelineRealtime invalida deals/history/evaluations; não há reload, drag ou UPDATE sintético.
    await Promise.all([
      proof.completion,
      expect
        .poll(
          async () => {
            if (captureError) throw captureError;
            return column().getAttribute("data-stage-id");
          },
          {
            timeout: 160_000,
            intervals: [100, 200, 500],
            message: "O negócio deve mudar de coluna via realtime.",
          },
        )
        .not.toBe(beforeId),
    ]);
    await expect(card).toHaveCount(1);
    const afterId = await column().getAttribute("data-stage-id");
    const afterName = await column().getAttribute("data-stage-name");
    if (!afterId || !afterName || afterId === beforeId)
      throw new Error("Não houve transição visível do negócio alvo.");
    const transitionFrame = frames.length;
    await card.scrollIntoViewIfNeeded();
    await expect.poll(() => frames.length - transitionFrame).toBeGreaterThanOrEqual(8);

    const persisted = JSON.parse(await readFile(proofPath, "utf8"));
    expect(persisted.deal_id, "A prova deve corresponder ao negócio filmado.").toBe(target.dealId);
    expect(persisted.from_stage_id).toBe(beforeId);
    expect(persisted.to_stage_id).toBe(afterId);
    expect(persisted.actor_type).toBe("ai");
    for (const key of ["history_id", "command_id", "event_id"]) {
      expect(persisted[key], `Auditoria deve conter ${key}.`).toMatch(/^[0-9a-f-]{36}$/i);
    }

    await card.getByRole("button", { name: /abrir detalhes da IA/ }).click();
    const history = page.getByRole("dialog", { name: "Decisão da IA no funil", exact: true });
    await expect(history).toBeVisible();
    await expect(
      history.getByText(`Movido de ${beforeName} para ${afterName}`, { exact: true }),
    ).toBeVisible();
    await expect(history.getByText(/^Movido pela IA /)).toBeVisible();
    await expectHealthyPage(page);
    const auditFrame = frames.length;
    await expect
      .poll(() => frames.length - auditFrame, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(24);
    recording = false;
    await capture;
    if (captureError) throw captureError;
    const recordedMs = Date.now() - startedAt;

    // Todos os quadros vêm do browser. Só a espera é acelerada; início, mudança e auditoria permanecem.
    const selected = [
      ...sampleFrames(frames.slice(0, triggerFrame), 8),
      ...sampleFrames(frames.slice(triggerFrame, transitionFrame), 32),
      ...sampleFrames(frames.slice(transitionFrame, auditFrame), 16),
      ...sampleFrames(frames.slice(auditFrame), 24),
    ];
    const fps = Math.min(8, selected.length / 6);
    const expectedSeconds = selected.length / fps;
    if (expectedSeconds < 5 || expectedSeconds > 12)
      throw new Error("A seleção de quadros não atende à duração de 5–12 segundos.");
    const concat = join(framesDir, "frames.ffconcat");
    await writeFile(
      concat,
      `ffconcat version 1.0\n${selected.map((file) => `file '${file}'\nduration ${1 / fps}`).join("\n")}\n`,
    );
    const palette = join(framesDir, "palette.png");
    await startProcess(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat,
        "-vf",
        "palettegen=stats_mode=diff",
        "-frames:v",
        "1",
        palette,
      ],
      60_000,
    ).completion;
    await startProcess(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat,
        "-i",
        palette,
        "-filter_complex",
        "[0:v][1:v]paletteuse=dither=sierra2_4a",
        "-loop",
        "0",
        gifPath,
      ],
      60_000,
    ).completion;
    if ((await stat(gifPath)).size === 0) throw new Error("O GIF gerado está vazio.");
    const { stdout } = await promisify(execFile)(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        gifPath,
      ],
      { timeout: 15_000 },
    );
    const actualSeconds = Number(stdout.trim());
    if (!Number.isFinite(actualSeconds) || actualSeconds < 5 || actualSeconds > 12) {
      throw new Error("A duração medida pelo ffprobe está fora de 5–12 segundos.");
    }
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          status: "COMPROVADO_LOCAL",
          baseURL,
          ...target,
          fromStageId: beforeId,
          toStageId: afterId,
          fromStageName: beforeName,
          toStageName: afterName,
          actorType: persisted.actor_type,
          historyId: persisted.history_id,
          commandId: persisted.command_id,
          eventId: persisted.event_id,
          realtime: true,
          recarregamentos: 0,
          framesCapturados: frames.length,
          framesNoGif: selected.length,
          duracaoGravacaoMs: recordedMs,
          duracaoGifEsperadaSegundos: expectedSeconds,
          duracaoGifSegundos: actualSeconds,
          edicao: "Quadros reais; espera acelerada por amostragem, sem movimento fabricado.",
          comando: [process.execPath, ...args],
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `GIF real criado: ${gifPath}; ${beforeName} → ${afterName}; ator IA; auditoria ${persisted.history_id}.`,
    );
  } catch (error) {
    await rm(gifPath, { force: true });
    throw error;
  } finally {
    recording = false;
    proof?.child.kill();
    await capture;
    await context.close();
    await browser.close();
    await rm(framesDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
