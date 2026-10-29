import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const skill = process.env.MOTIONMAXXING_SKILL ?? '/home/freedom/.claude/skills/motionmaxxing';
const mode = process.argv[2] ?? 'final';
const settings = {
  draft: ['draft.mp4', 'scenes/index.html', 60],
  final: ['../apresentacao/aceleraflow-clinica-ft.mp4', 'scenes/index.html', 60],
  kanban: ['../apresentacao/kanban-auto.mp4', 'scenes/kanban-recording.html', 9],
};
if (!settings[mode]) throw new Error('Use draft, final ou kanban.');
const [name, html, duration] = settings[mode];
const out = resolve(root, `reports/${mode}`);
await mkdir(out, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
// O registro de eventos do render fica nesta pasta, não ao lado do MP4 em ../apresentacao/.
const events = resolve(root, `${basename(name)}.events.json`);
const look = run('python3', [resolve(skill, 'scripts/look.py'), resolve(root, name), '--events', events, '--out', out, '--expect', String(duration), '--hold-warn', '1.4']);
await writeFile(resolve(out, 'look.txt'), `${look.stdout}\n${look.stderr}`);
console.log(look.stdout.trim());
const samples = JSON.parse(await readFile(resolve(root, 'scenes/samples.json'), 'utf8'));
const times = mode === 'kanban' ? '0.7,4.5,5.8,7.3,8.8' : samples.map(sample => sample.time).join(',');
const lint = run('node', [resolve(skill, 'scripts/lint.mjs'), resolve(root, html), '--times', times, '--json']);
await writeFile(resolve(out, 'lint.json'), lint.stdout);
if (lint.stderr) await writeFile(resolve(out, 'lint-stderr.txt'), lint.stderr);
console.log(lint.stdout.trim());
const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,codec_type,width,height,avg_frame_rate,nb_frames', '-of', 'json', resolve(root, name)]);
await writeFile(resolve(out, 'media.json'), probe.stdout);
const baseline = [
  'fb6f7aa5f2313d501e4f054be8f100b6b3eacee4027d775ee46de9453984449c',
  '945d58080bd1f37baa8e79f689d6089bdb5af7c6ea8f94101a374974e32db85b',
  '646b67703e7175d3786ddafea12912d92eedc5e91de13be61aee448d7e9c8496',
  '47ac01e210e4f1463e0d1cc550b6db5696c4f4c210ee5b992ae394cef1261433',
  'b306ff8b6efc27c9e16e8b08f0292f1f9631f65281956cbfb01c3ed2796d9df5',
  'a12a1679fb89d88025520475900dd4a0df739cb350f647a9942bf862c5699a13',
  '7cba56c7eb3de7a17301c0df26245f7d3252f0bf633ef4b5e39f9a75de109011',
  'f14e63526111fca603829a11d53d6d9d3b4f39f8588d9cd74133dbbf4309a187',
  'b162a0d2fa7d49ad9c90d4b5e1efd5593760b70f63725d6f95956f5977971f83',
];
const originals = resolve(root, '../screenshots-pre-deploy');
const files = (await readdir(originals)).filter(file => file.endsWith('.png')).sort();
const checks = await Promise.all(files.map(async (file, index) => {
  const sha256 = createHash('sha256').update(await readFile(resolve(originals, file))).digest('hex');
  return { file, sha256, intacta: sha256 === baseline[index] };
}));
await writeFile(resolve(out, 'originais.json'), JSON.stringify(checks, null, 2));
if (files.length !== 9 || checks.some(check => !check.intacta)) throw new Error('Uma captura original difere do hash inicial.');
console.log('Capturas originais: 9/9 hashes SHA-256 intactos.');
if (mode === 'final') {
  const production = JSON.parse(await readFile(resolve(root, 'reports/prod-baseline.json'), 'utf8'));
  const current = await Promise.all([...production.capturasPublicadas, ...production.fontesSelecionadas].map(async source => {
    const sha256 = createHash('sha256').update(await readFile(resolve(root, source.path))).digest('hex');
    return { ...source, sha256Atual: sha256, intacta: sha256 === source.sha256 };
  }));
  await writeFile(resolve(out, 'fontes-producao.json'), JSON.stringify(current, null, 2));
  if (production.capturasPublicadas.filter(source => /\/0[1-9]-/.test(source.path)).length !== 9 || current.some(source => !source.intacta)) throw new Error('Uma captura publicada ou fonte mudou durante a renderização.');
  console.log(`Produção: ${production.capturasPublicadas.length} capturas (nove principais e suplemento) e ${production.fontesSelecionadas.length} fontes selecionadas intactas.`);
}
process.exitCode = look.status || lint.status || probe.status;
