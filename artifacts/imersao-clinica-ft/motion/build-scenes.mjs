import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(await readFile(resolve(root, 'scenes/plan.json'), 'utf8'));
function html(scenes, title) {
  return `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="../runtime/fonts.css"><link rel="stylesheet" href="composition.css"></head>\n<body><main id="main"></main><script src="../runtime/vendor/gsap.min.js"></script><script src="../runtime/motion.js"></script><script src="composition.js"></script><script>composeFilm(${JSON.stringify(scenes)});</script></body></html>\n`;
}
for (const scene of plan) await writeFile(resolve(root, `scenes/${scene.id}.html`), html([scene], scene.title));
await writeFile(resolve(root, 'scenes/index.html'), html(plan, 'AceleraFlow — Clínica FT'));
let cursor = 0;
const samples = [];
for (const scene of plan) {
  for (const shot of scene.shots ?? []) {
    samples.push({ time: +(cursor + shot.seconds / 2).toFixed(2), scene: scene.id, subject: shot.subject });
    cursor += shot.seconds;
  }
  if (scene.video) {
    samples.push({ time: cursor + 4.5, scene: scene.id, subject: 'Mariana na coluna de destino na gravação histórica' });
    for (const shot of [{ seconds: 5.7, subject: 'Antes e depois do avanço em homologação' }, { seconds: 1.5, subject: 'Ator IA no painel de auditoria local' }, { seconds: 1.8, subject: 'Confiança e transição locais auditadas' }]) {
      samples.push({ time: +(cursor + shot.seconds / 2).toFixed(2), scene: scene.id, subject: shot.subject });
      cursor += shot.seconds;
    }
  }
}
samples.sort((a, b) => a.time - b.time);
await writeFile(resolve(root, 'scenes/samples.json'), JSON.stringify(samples, null, 2));
console.log(`Geradas nove cenas e composição principal de ${cursor.toFixed(2)} s; ${samples.length} enquadramentos de inspeção.`);
