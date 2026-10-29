#!/usr/bin/env node
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
const skill = resolve(homedir(), '.claude/skills/motionmaxxing');
for (const dir of ['runtime', 'source/prod', 'source/branch', 'scenes']) await mkdir(resolve(root, dir), { recursive: true });
for (const file of ['motion.js', 'fonts.css', 'fonts', 'vendor']) await cp(resolve(skill, 'runtime', file), resolve(root, 'runtime', file), { recursive: true });
await cp(resolve(root, '../apresentacao/onboarding/03-passo.png'), resolve(root, 'source/prod/wizard-nicho.png'));
await cp(resolve(root, '../screenshots-pre-deploy/06-kanban-automatico.png'), resolve(root, 'source/prod/funil-publicado.png'));
await cp(resolve(root, '../kanban-auto.gif'), resolve(root, 'source/kanban-original.gif'));
await cp(resolve(root, '../kanban-auto.json'), resolve(root, 'source/kanban-evidencia.json'));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', resolve(root, 'source/kanban-original.gif'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '16', '-movflags', '+faststart', resolve(root, 'source/kanban-captura.mp4')], { stdio: 'inherit' });
await writeFile(resolve(root, 'source/escolha-kanban.json'), JSON.stringify({
  opcao: 'A', fonte: '../kanban-auto.gif', resolucaoOriginal: [1440, 900],
  motivo: 'A transição seguinte exige realização da avaliação e proposta revisada por profissional; o agendamento atual é futuro e confirmed. Não foi fabricado evento para obter nova gravação.',
  consultaSomenteLeitura: 'AmbienteLocalDemo, 2026-10-15 19:53:10 UTC',
  movimento: 'Qualificado → Avaliação Agendada', ator: 'ai',
  novoAvancoExecutado: false, brutoWebmNovo: false,
  edicao: 'Ampliação e reenquadramento dos pixels originais; nenhuma UI ou movimentação redesenhada.',
}, null, 2));
console.log('Runtime isolado e fontes originais preservadas.');
