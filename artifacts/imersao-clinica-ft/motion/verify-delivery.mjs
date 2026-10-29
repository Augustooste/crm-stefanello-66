import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const report = { arquivos: {}, capturasOriginaisIntactas: 0, fontesKanbanIguais: false, arquivosTextoInspecionados: 0, segredosEncontrados: 0 };
// Os entregáveis de mídia ficam na pasta da apresentação; as chaves do relatório seguem só com o nome do arquivo.
for (const [name, minimum, maximum, dimensions] of [
  ['aceleraflow-clinica-ft.mp4', 45, 60, [1920, 1080]],
  ['kanban-auto.mp4', 5, 12, [1920, 1080]],
  ['kanban-auto.gif', 5, 12, [960, 540]],
]) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,codec_type,width,height,nb_frames,avg_frame_rate', '-of', 'json', resolve(root, '../apresentacao', name)], { encoding: 'utf8' });
  if (probe.status) throw new Error(`ffprobe falhou: ${name}`);
  const data = JSON.parse(probe.stdout);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const duration = Number(data.format.duration);
  if (!video || video.width !== dimensions[0] || video.height !== dimensions[1] || !Number.isFinite(duration) || duration < minimum || duration > maximum || !(Number(video.nb_frames) > 1) || data.streams.some(stream => stream.codec_type === 'audio')) throw new Error(`Contrato de mídia inválido: ${name}`);
  if (name.endsWith('.gif') && Number(data.format.size) > 8_000_000) throw new Error('O GIF excede 8 MB.');
  report.arquivos[name] = data;
}
for (const name of ['STORYBOARD.md', 'NOTE.md', 'contact-sheet-1.jpg', 'contact-sheet-2.jpg', 'contact-sheet-3.jpg', 'contact-sheet-4.jpg']) report.arquivos[name] = { bytes: (await stat(resolve(root, name))).size };
const htmls = (await readdir(resolve(root, 'scenes'))).filter(name => /^\d{2}-.+\.html$/.test(name));
if (htmls.length !== 9) throw new Error('São necessárias nove composições HTML.');
report.cenasHtml = htmls.sort();
const plan = JSON.parse(await readFile(resolve(root, 'scenes/plan.json'), 'utf8'));
report.procedencia = plan.map(scene => ({ cena: scene.id, origem: scene.origin, fontes: [...(scene.shots ?? []).map(shot => shot.source), ...(scene.video ? [scene.video] : [])] }));
for (const scene of plan) {
  if (scene.id === '06-kanban') {
    if (scene.origin !== 'mixed' || !scene.video || scene.shots.some(shot => !shot.source.startsWith('../source/prod/') || !shot.caption?.startsWith('Captura real · produção'))) throw new Error('A cena 6 precisa distinguir o registro de produção da gravação histórica.');
  }
  if ((scene.id !== '06-kanban' && scene.origin !== 'prod') || scene.shots.some(shot => !shot.source.startsWith('../source/prod/'))) throw new Error(`Fonte não migrada para produção: ${scene.id}`);
  if (scene.shots.some(shot => /homologação|não publicada|pendente de publicação/.test(shot.caption ?? ''))) throw new Error(`Legenda obsoleta: ${scene.id}`);
}
const checks = JSON.parse(await readFile(resolve(root, 'reports/final/originais.json'), 'utf8'));
report.capturasOriginaisIntactas = checks.filter(check => check.intacta).length;
if (report.capturasOriginaisIntactas !== 9) throw new Error('Integridade das nove capturas não comprovada.');
report.fontesProducao = JSON.parse(await readFile(resolve(root, 'reports/final/fontes-producao.json'), 'utf8'));
if (report.fontesProducao.some(source => !source.intacta)) throw new Error('Uma fonte publicada mudou após o registro dos hashes.');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
report.fontesKanbanIguais = await hash(resolve(root, 'source/kanban-original.gif')) === await hash(resolve(root, '../kanban-auto.gif'));
if (!report.fontesKanbanIguais) throw new Error('A fonte do Kanban diverge do original.');
report.legendas = JSON.parse(await readFile(resolve(root, 'reports/caption-layout.json'), 'utf8'));
if (report.legendas.some(item => item.sobreposicoes || item.distanciaMinimaPx <= 0)) throw new Error('Legenda sem separação física comprovada.');
report.framesDeRevisaoPorSegundo = (await readdir(resolve(root, 'review-1s/stills'))).filter(name => name.endsWith('.png')).length;
if (report.framesDeRevisaoPorSegundo !== 60) throw new Error('Revisão de um frame por segundo incompleta.');
report.capturaPadrao = JSON.parse(await readFile(resolve(root, 'reports/capture-default.json'), 'utf8'));
const password = parseEnv(await readFile('/home/freedom/.config/aceleraflow-imersao/credentials.env', 'utf8')).CLINICA_FT_PASSWORD;
if (!password) throw new Error('Credencial autorizada indisponível para varredura.');
const textExtensions = new Set(['.md', '.json', '.txt', '.html', '.js', '.mjs', '.css', '.py']);
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (textExtensions.has(extname(entry.name))) {
      const text = await readFile(path, 'utf8');
      report.arquivosTextoInspecionados++;
      if (text.includes(password) || /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(text)) throw new Error(`Segredo em artefato textual: ${path}`);
    }
  }
}
await scan(root);
await writeFile(resolve(root, 'reports/acceptance.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
