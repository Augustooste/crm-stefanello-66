import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const screenshots = (await readdir(resolve(root, '../apresentacao/telas'))).filter(name => name.endsWith('.png')).sort();
if (screenshots.filter(name => /^0[1-9]-/.test(name)).length !== 9) throw new Error('A recaptura publicada ainda não contém as nove imagens principais.');
const plan = JSON.parse(await readFile(resolve(root, 'scenes/plan.json'), 'utf8'));
const sources = [...new Set(plan.flatMap(scene => (scene.shots ?? []).map(shot => relative(root, resolve(root, 'scenes', shot.source)))))];
if (sources.some(path => !path.startsWith('source/prod/'))) throw new Error('Uma cena estática ainda usa fonte fora de produção.');
async function record(path) {
  return { path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') };
}
const baseline = {
  registradoEm: new Date().toISOString(),
  capturasPublicadas: await Promise.all(screenshots.map(name => record(`../apresentacao/telas/${name}`))),
  fontesSelecionadas: await Promise.all(sources.map(record)),
};
await writeFile(resolve(root, 'reports/prod-baseline.json'), JSON.stringify(baseline, null, 2));
console.log(`Registrados os hashes de ${baseline.capturasPublicadas.length} capturas publicadas e ${baseline.fontesSelecionadas.length} fontes selecionadas, antes da renderização.`);
