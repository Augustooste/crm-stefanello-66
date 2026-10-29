import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const reports = [];
try {
  for (const file of ['scenes/index.html', 'scenes/kanban-recording.html']) {
    await page.goto(pathToFileURL(resolve(root, file)).href);
    await page.evaluate(() => window.__ready);
    const result = await page.evaluate(async () => {
      const total = Math.round(window.__duration * 30);
      let checked = 0, baked = 0, gap = Infinity;
      const violations = [];
      for (let frame = 0; frame < total; frame++) {
        await window.__seek(frame / 30);
        const captions = [...document.querySelectorAll('.provenance, #provenance')].filter(el => getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none');
        if (captions.length === 0) {
          const embedded = [...document.querySelectorAll('.shot video')].some(el => getComputedStyle(el).visibility !== 'hidden');
          if (!embedded) violations.push({ frame, motivo: 'Legenda ausente sem vídeo já legendado.' });
          baked++;
          continue;
        }
        checked++;
        if (captions.length !== 1) violations.push({ frame, motivo: 'Mais de uma legenda ativa.' });
        for (const caption of captions) {
          const scene = caption.closest('.shot') ?? document.querySelector('#main');
          const capture = scene.querySelector('.capture-viewport, #capture-viewport');
          if (!capture || getComputedStyle(capture).overflow !== 'hidden') {
            violations.push({ frame, motivo: 'Captura sem recorte físico.' });
            continue;
          }
          const imageRect = capture.getBoundingClientRect();
          const textRect = caption.getBoundingClientRect();
          gap = Math.min(gap, textRect.top - imageRect.bottom);
          if (textRect.top < imageRect.bottom || textRect.bottom > 1080 || textRect.left < 0 || textRect.right > 1920) violations.push({ frame, motivo: 'Legenda invade captura ou sai do quadro.' });
        }
      }
      return { quadrosPercorridos: total, quadrosComLegenda: checked, quadrosComVideoJaLegendado: baked, distanciaMinimaPx: gap, sobreposicoes: violations.length, ocorrencias: violations, buscaDeterministica: window.__seekcheck };
    });
    reports.push({ arquivo: file, ...result });
  }
} finally {
  await browser.close();
}
await writeFile(resolve(root, 'reports/caption-layout.json'), JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports, null, 2));
if (reports.some(report => report.sobreposicoes || !report.buscaDeterministica.ok)) process.exitCode = 1;
