#!/usr/bin/env node
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { signInClinica, expectHealthyPage, verifyInbox } from '../../../e2e/imersao-clinica-ft/jornada-helpers.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const phase = process.argv[2] ?? 'settings';
const profile = process.argv[3] ?? 'branch';
if (!['branch', 'prod'].includes(profile)) throw new Error('Perfil inválido: use branch ou prod.');
const baseURL = profile === 'prod' ? 'https://aceleraflow-remix.lovable.app' : 'http://127.0.0.1:5173';
const prefix = profile === 'prod' ? 'complemento-' : '';
const output = resolve(root, `source/${profile}`);
const credentials = parseEnv(await readFile(resolve(homedir(), '.config/aceleraflow-imersao/credentials.env'), 'utf8'));
process.env.CLINICA_FT_EMAIL = credentials.CLINICA_FT_EMAIL;
process.env.CLINICA_FT_PASSWORD = credentials.CLINICA_FT_PASSWORD;
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'pt-BR' });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const records = [];
async function navigate(name, route) {
  await page.getByRole('link', { name, exact: true }).click();
  await page.waitForURL(url => url.pathname === route);
  await expectHealthyPage(page);
}
async function capture(name) {
  await expectHealthyPage(page);
  await page.screenshot({ path: resolve(output, `${prefix}${name}.png`), fullPage: false });
  const ui = await page.evaluate(() => ({
    font: getComputedStyle(document.body).fontFamily,
    controls: [...document.querySelectorAll('button,[role="tab"],[role="combobox"],h1,h2,h3,label')].map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim().slice(0, 150), role: el.getAttribute('role'), aria: el.getAttribute('aria-label'), x: r.x, y: r.y, w: r.width, h: r.height, font: getComputedStyle(el).fontSize };
    }).filter(el => el.w && el.h && el.y < 1080 && el.y + el.h > 0),
  }));
  records.push({ file: `${prefix}${name}.png`, profile, baseURL, capturedAt: new Date().toISOString(), route: new URL(page.url()).pathname, ...ui });
  await writeFile(resolve(output, `${prefix}${phase}-metadata.json`), JSON.stringify(records, null, 2));
  await writeFile(resolve(output, `${prefix}${name}.txt`), await page.locator('body').innerText());
  console.log(`Capturada ${profile}/${prefix}${name}.png (1920×1080).`);
}
try {
  await signInClinica(page);
  if (phase === 'settings') {
    await navigate('Configurações', '/configuracoes');
    await page.getByRole('tab', { name: 'IA', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistente', exact: true }).click();
    await page.getByRole('tab', { name: 'Configuração', exact: true }).click();
    await capture('assistente-topo');
    await page.getByLabel('Prompt base do assistente', { exact: true }).scrollIntoViewIfNeeded();
    await capture('02-configuracao-ia');
    await page.getByRole('heading', { name: 'Comportamento das respostas', exact: true }).scrollIntoViewIfNeeded();
    await capture('03-comportamento-ia');
    await page.getByRole('radio', { name: 'Sempre em áudio', exact: true }).evaluate(el => el.scrollIntoView({ block: 'center' }));
    await capture('comportamento-modalidades');
    await page.getByRole('tab', { name: 'Área de teste', exact: true }).click();
    await capture('playground');
  } else if (phase === 'handoff') {
    await navigate('Configurações', '/configuracoes');
    await page.getByRole('tab', { name: 'IA', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistente', exact: true }).click();
    await expectHealthyPage(page);
    await expect(page.getByLabel('Máximo de blocos por resposta', { exact: true })).toHaveValue('3');
    const handoffHeading = page.getByRole('heading', { name: 'Palavras de transferência (padrão)', exact: true });
    await handoffHeading.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    expect(await handoffHeading.evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(750);
    await capture('transferencia-humana');
  } else if (phase === 'contact') {
    if (profile === 'prod') {
      const contactId = process.env.IMERSAO_CONTACT_ID;
      if (!contactId) throw new Error('Informe IMERSAO_CONTACT_ID para capturar o contato real de produção.');
      await page.goto(`/contatos/${contactId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Mariana Lopes', exact: true })).toBeVisible();
    } else {
      await navigate('Contatos', '/contatos');
      await page.getByRole('textbox', { name: 'Buscar contatos', exact: true }).fill('Mariana Lopes');
      await page.getByRole('row').filter({ hasText: 'Mariana Lopes' }).getByText('Mariana Lopes', { exact: true }).click();
    }
    await page.getByRole('tab', { name: 'Memória IA', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Perfil consolidado', exact: true })).toBeVisible();
    await capture('05-ficha-cliente');
    await page.getByRole('heading', { name: 'Informações extraídas pela IA', exact: true }).scrollIntoViewIfNeeded();
    await capture('ficha-extracao');
    await page.getByRole('region', { name: 'Qualificação por IA', exact: true }).scrollIntoViewIfNeeded();
    await capture('ficha-qualificacao');
    await page.getByRole('heading', { name: 'Perfil consolidado', exact: true }).scrollIntoViewIfNeeded();
    await capture('ficha-memoria');
  } else if (phase === 'inbox-nav') {
    await navigate('Conversas', '/inbox');
    await capture('inbox-navegacao');
  } else if (phase === 'inbox') {
    if (profile === 'prod') {
      await verifyInbox(page, 'prod');
    } else {
      await navigate('Conversas', '/inbox');
      await page.getByRole('tab', { name: 'Lista', exact: true }).click();
      await page.getByRole('combobox', { name: 'Selecionar período do filtro global' }).click();
      await page.getByRole('option', { name: 'Últimos 90 dias', exact: true }).click();
      await page.getByRole('textbox', { name: 'Buscar conversa', exact: true }).fill('Mariana Lopes');
      await page.getByRole('listbox', { name: 'Lista de conversas' }).getByRole('button', { name: /Mariana Lopes SIMULAÇÃO/ }).click();
      await expect(page.getByRole('heading', { name: 'Mariana Lopes', exact: true })).toBeVisible();
    }
    await capture('04-whatsapp-chat');
    const answer = profile === 'prod' ? 'Na avaliação, o dentista examina sua saúde bucal e planeja o tratamento ideal para você.\nQual tratamento você procura e já fez alguma avaliação antes?' : 'Nossa avaliação é o primeiro passo para um plano de tratamento personalizado.';
    await page.getByText(answer, { exact: true }).evaluate(el => el.scrollIntoView({ block: 'center' }));
    await capture('conversa-blocos-ia');
  } else if (phase === 'autonomy') {
    await navigate('Funil', '/pipeline');
    await page.getByRole('button', { name: 'Autonomia', exact: true }).click();
    const confidence = page.getByRole('spinbutton', { name: 'Confiança da transição Em Atendimento → Qualificado', exact: true });
    await expect(confidence).toHaveValue('80');
    await confidence.scrollIntoViewIfNeeded();
    await capture('07-autonomia-aprovacao');
    await page.getByRole('combobox', { name: 'Modo da transição Em Atendimento → Qualificado', exact: true }).click();
    await capture('autonomia-quatro-modos');
  } else if (phase === 'decisions') {
    await navigate('Decisões', '/decisions');
    await expect(page.getByRole('heading', { name: 'Nenhuma decisão pendente', exact: true }).or(page.getByRole('button', { name: 'Aprovar', exact: true })).first()).toBeVisible();
    await capture('fila-decisoes');
  } else if (phase === 'nurture') {
    await navigate('Acompanhamento automático', '/nurture');
    await page.getByRole('button', { name: /^Confirmação de Avaliação Agendada/ }).click();
    await capture('followup-sequencia');
    await page.getByRole('tab', { name: /^Inscrições \(\d+\)$/ }).click();
    await capture('followup-inscricoes');
    await page.getByRole('button', { name: 'Histórico', exact: true }).nth(profile === 'prod' ? 0 : 1).click();
    await capture('followup-historico');
  } else if (phase === 'dashboard') {
    await page.getByRole('combobox', { name: 'Selecionar período do filtro global' }).click();
    await page.getByRole('option', { name: 'Últimos 90 dias', exact: true }).click();
    await page.getByRole('heading', { name: 'Performance da IA (revisão humana)', exact: true }).scrollIntoViewIfNeeded();
    await capture('09-dashboard');
    await page.getByRole('heading', { name: 'Performance da IA (revisão humana)', exact: true }).evaluate(el => el.scrollIntoView({ block: 'center' }));
    await capture('dashboard-ia');
  } else throw new Error('Etapa de captura inválida.');
} catch (error) {
  console.error(`Captura interrompida: ${String(error.message).replaceAll(credentials.CLINICA_FT_PASSWORD, '[SEGREDO OMITIDO]').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[TOKEN OMITIDO]')}`);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
const originals = resolve(root, '../screenshots-pre-deploy');
const hashes = {};
for (const file of (await readdir(originals)).filter(name => name.endsWith('.png')).sort()) hashes[file] = createHash('sha256').update(await readFile(resolve(originals, file))).digest('hex');
await writeFile(resolve(root, 'source/originais-sha256.json'), JSON.stringify(hashes, null, 2));
