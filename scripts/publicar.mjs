#!/usr/bin/env node
/**
 * /publicar — publica ou agenda Reels no Instagram pela API oficial da Meta.
 *
 *   node scripts/publicar.mjs roteiros/x.json --agora
 *   node scripts/publicar.mjs roteiros/x.json --em "2026-11-09 12:00"
 *   node scripts/publicar.mjs roteiros/lote-01 --a-partir-de "2026-11-09 12:00"   (um por dia, em ordem)
 *   node scripts/publicar.mjs --fila        (publica o que estiver na hora; o agendador do Mac roda isto a cada 10 min)
 *   node scripts/publicar.mjs --listar      (mostra a fila)
 *   node scripts/publicar.mjs --cancelar <slug>
 *
 * .env: IG_USER_ID, IG_TOKEN + hospedagem temporária: HOSPEDAGEM=r2|github|tmpfiles
 *   r2: R2_BUCKET, R2_PUBLIC_URL · github: GITHUB_REPO (público) · tmpfiles: nada (expira em 60 min)
 * O vídeo precisa estar numa URL pública por alguns minutos (a Meta baixa o arquivo).
 */
import { promises as fs, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, precisa } from './env.mjs';

const args = process.argv.slice(2);
const alvo = args.find(a => !a.startsWith('--'));
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const tem = (k) => args.includes('--' + k);
const FILA = path.join(ROOT, 'data', 'fila-publicacao.json');
const V = process.env.GRAPH_VERSION || 'v21.0';

const fila = existsSync(FILA) ? JSON.parse(await fs.readFile(FILA, 'utf8')) : [];
const salvarFila = () => fs.writeFile(FILA, JSON.stringify(fila, null, 2) + '\n');

if (tem('listar')) { listar(); process.exit(0); }
if (tem('cancelar')) { const s = opt('cancelar'); const i = fila.findIndex(f => f.slug === s && f.status === 'agendado'); if (i < 0) { console.log('não achei', s); } else { fila.splice(i, 1); await salvarFila(); console.log('cancelado', s); } process.exit(0); }
if (tem('fila')) { await processarFila(); process.exit(0); }
if (!alvo) { console.error('uso: node scripts/publicar.mjs <roteiro.json|pasta> --agora | --em "AAAA-MM-DD HH:MM" | --a-partir-de "AAAA-MM-DD HH:MM"'); process.exit(1); }

const roteiros = statSync(path.resolve(ROOT, alvo)).isDirectory()
  ? readdirSync(path.resolve(ROOT, alvo)).filter(f => f.endsWith('.json')).sort().map(f => path.join(alvo, f))
  : [alvo];

if (tem('agora')) {
  for (const r of roteiros) await publicar(await carregar(r));
} else if (opt('em') || opt('a-partir-de')) {
  let quando = parseData(opt('em') || opt('a-partir-de'));
  for (const r of roteiros) {
    const item = await carregar(r);
    const existente = fila.find(f => f.slug === item.slug && ['agendado', 'erro'].includes(f.status)); // reagendar um que falhou reaproveita a entrada
    if (existente) { existente.quando = quando.toISOString(); existente.status = 'agendado'; delete existente.erro; }
    else fila.push({ slug: item.slug, roteiro: r, quando: quando.toISOString(), status: 'agendado' });
    console.log(`agendado  ${item.slug}  →  ${fmt(quando)}`);
    for (const f of [item.mp4, item.capa].filter(Boolean)) { const dest = path.join(ROOT, 'saida', 'agendados', path.basename(f)); if (f !== dest && existsSync(f)) { await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.rename(f, dest).catch(() => {}); } }
    if (opt('a-partir-de')) quando = new Date(quando.getTime() + 86400000);
  }
  await salvarFila();
  console.log('\nA fila é publicada pelo agendador do Mac (scripts/agendador-instalar.sh) ou com: node scripts/publicar.mjs --fila');
} else {
  console.error('diga --agora, --em "data hora" ou --a-partir-de "data hora"'); process.exit(1);
}

/* ---------------- núcleo ---------------- */
async function carregar(rel) {
  const p = path.resolve(ROOT, rel);
  const rot = JSON.parse(await fs.readFile(p, 'utf8'));
  const slug = rot.slug || path.basename(p, '.json');
  /* procura o vídeo na raiz de saida/ e nas subpastas de trabalho */
  let mp4 = null, capa = null;
  for (const d of ['', 'agendados', 'prontos', 'exemplos']) { const c = path.join(ROOT, 'saida', d, slug + '.mp4'); if (existsSync(c)) { mp4 = c; capa = path.join(ROOT, 'saida', d, slug + '-capa.jpg'); break; } }
  if (!mp4) throw new Error(`vídeo não encontrado: saida/**/${slug}.mp4 (rode /anima ou /motion antes)`);
  const legenda = [rot.legenda || '', (rot.hashtags || []).join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
  return { slug, roteiro: rel, mp4, capa: existsSync(capa) ? capa : null, legenda };
}

async function publicar(item) {
  const IG = precisa('IG_USER_ID', 'ID da conta profissional do Instagram.');
  const TOKEN = precisa('IG_TOKEN', 'Token de longa duração com instagram_content_publish.');
  const host = hospedagem();
  const stamp = Date.now();
  const kVideo = `${item.slug}-${stamp}.mp4`, kCapa = `${item.slug}-${stamp}.jpg`;

  console.log(`\n▶ ${item.slug}`);
  process.stdout.write(`  subindo (${host.nome})… `);
  const urlVideo = await host.subir(item.mp4, kVideo, 'video/mp4');
  const urlCapa = item.capa ? await host.subir(item.capa, kCapa, 'image/jpeg') : null;
  console.log('ok');

  try {
    process.stdout.write('  criando o reel na Meta… ');
    const params = { media_type: 'REELS', video_url: urlVideo, caption: item.legenda, share_to_feed: 'true' };
    if (urlCapa) params.cover_url = urlCapa;
    const cont = await graph('POST', `${IG}/media`, params, TOKEN);
    console.log('container', cont.id);

    process.stdout.write('  processando');
    let st;
    for (let i = 0; i < 60; i++) {
      await espera(5000);
      st = await graph('GET', `${cont.id}`, { fields: 'status_code,status' }, TOKEN);
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('Meta recusou o vídeo: ' + (st.status || st.status_code));
      process.stdout.write('.');
    }
    if (st.status_code !== 'FINISHED') throw new Error('tempo esgotado processando o vídeo');
    console.log(' pronto');

    const pub = await graph('POST', `${IG}/media_publish`, { creation_id: cont.id }, TOKEN);
    const info = await graph('GET', `${pub.id}`, { fields: 'permalink,timestamp' }, TOKEN);
    console.log(`  ✓ publicado: ${info.permalink}`);
    await marcarCalendario(item.slug, info.permalink);
    await arquivarPublicado(item, (info.timestamp || new Date().toISOString()).slice(0, 10));
    return info.permalink;
  } finally {
    await host.apagar(kVideo).catch(() => {}); if (item.capa) await host.apagar(kCapa).catch(() => {});
  }
}

async function processarFila() {
  const agora = Date.now();
  const devidos = fila.filter(f => f.status === 'agendado' && new Date(f.quando).getTime() <= agora);
  if (!devidos.length) { console.log('nada na hora. próximos:'); listar(); return; }
  for (const f of devidos) {
    try {
      const link = await publicar(await carregar(f.roteiro));
      f.status = 'postado'; f.link = link; f.publicado_em = new Date().toISOString();
    } catch (e) {
      f.status = 'erro'; f.erro = e.message; console.error('  ✗', e.message);
    }
    await salvarFila();
  }
}

function listar() {
  if (!fila.length) return console.log('(fila vazia)');
  for (const f of fila) console.log(`${f.status.padEnd(9)} ${fmt(new Date(f.quando)).padEnd(18)} ${f.slug}${f.link ? '  ' + f.link : ''}${f.erro ? '  ✗ ' + f.erro : ''}`);
}

async function arquivarPublicado(item, data) {
  if (process.env.NUVEM) { for (const f of [item.mp4, item.capa].filter(Boolean)) await fs.unlink(f).catch(() => {}); return; }
  const dir = path.join(ROOT, 'saida', 'publicados'); await fs.mkdir(dir, { recursive: true });
  for (const f of [item.mp4, item.capa].filter(Boolean)) {
    const dest = path.join(dir, `${data}-${path.basename(f)}`);
    try { await fs.rename(f, dest); } catch {}
  }
  await fs.rm(path.join(ROOT, 'saida', '.tmp'), { recursive: true, force: true }).catch(() => {});
}
async function marcarCalendario(slug, link) {
  const p = path.join(ROOT, 'data', 'calendario.md');
  if (!existsSync(p)) return;
  let md = await fs.readFile(p, 'utf8');
  const linhas = md.split('\n');
  let achou = false;
  for (let i = 0; i < linhas.length; i++) {
    if (linhas[i].includes(slug) && linhas[i].startsWith('|')) {
      linhas[i] = linhas[i].replace(/\|\s*(pronto|preview|roteiro|ideia)\s*\|/, '| postado |') + (linhas[i].includes(link) ? '' : ` ${link}`);
      achou = true; break;
    }
  }
  if (!achou) linhas.push(`| ${new Date().toISOString().slice(0, 10)} | — | animação | — | ${slug} | postado | ${link} |`);
  await fs.writeFile(p, linhas.join('\n'));
}

/* ---------------- utilitários ---------------- */
async function graph(method, p, params, token) {
  const u = new URL(`https://graph.facebook.com/${V}/${p}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === 'GET'
    ? await fetch(u + '?' + body.toString())
    : await fetch(u, { method: 'POST', body });
  const j = await r.json();
  if (j.error) { const dica = /blocked|permission|restrict/i.test(j.error.message) ? ' → verifique developers.facebook.com (Ações necessárias) e business.facebook.com/accountquality' : ''; throw new Error(`${p}: ${j.error.message} (code ${j.error.code}${j.error.error_subcode ? '/' + j.error.error_subcode : ''})${dica}`); }
  return j;
}
/* ---------------- hospedagem temporária do vídeo (a Meta baixa de uma URL pública) ----------------
   HOSPEDAGEM=r2 | github | tmpfiles  (no .env; padrão: o primeiro configurado) */
function hospedagem() {
  const tipo = (process.env.HOSPEDAGEM || (process.env.R2_BUCKET ? 'r2' : process.env.GITHUB_REPO ? 'github' : 'tmpfiles')).toLowerCase();
  if (tipo === 'r2') {
    const BUCKET = precisa('R2_BUCKET', 'Nome do bucket no Cloudflare R2.');
    const PUB = precisa('R2_PUBLIC_URL', 'URL pública do bucket.').replace(/\/$/, '');
    return {
      nome: 'Cloudflare R2',
      subir: async (file, key, ct) => { sh('npx', ['-y', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--remote', '--file', file, '--content-type', ct], 'wrangler falhou (fez `npx wrangler login`?)'); return `${PUB}/${key}`; },
      apagar: async (key) => { sh('npx', ['-y', 'wrangler', 'r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']); }
    };
  }
  if (tipo === 'github') {
    const REPO = precisa('GITHUB_REPO', 'Repositório público, ex.: usuario/det-studio-midia (crie com: gh repo create det-studio-midia --public).');
    const TAG = process.env.GITHUB_TAG || 'midia';
    return {
      nome: 'GitHub Releases',
      subir: async (file, key, ct) => {
        const tmp = path.join(path.dirname(file), key); await fs.copyFile(file, tmp);
        const existe = spawnSync('gh', ['release', 'view', TAG, '-R', REPO], { encoding: 'utf8' }).status === 0;
        if (!existe) sh('gh', ['release', 'create', TAG, '-R', REPO, '--title', 'Mídia temporária do det-studio', '--notes', 'Arquivos ficam aqui só enquanto a Meta baixa.'], 'gh release create falhou (fez `gh auth login`?)');
        sh('gh', ['release', 'upload', TAG, tmp, '-R', REPO, '--clobber'], 'gh release upload falhou');
        await fs.unlink(tmp).catch(() => {});
        return `https://github.com/${REPO}/releases/download/${TAG}/${key}`;
      },
      apagar: async (key) => { sh('gh', ['release', 'delete-asset', TAG, key, '-R', REPO, '-y']); }
    };
  }
  if (tipo === 'tmpfiles') {
    return {
      nome: 'tmpfiles.org (expira em 60 min)',
      subir: async (file, key, ct) => {
        const fd = new FormData(); fd.append('file', new Blob([await fs.readFile(file)], { type: ct }), key);
        const r = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd });
        const j = await r.json().catch(() => ({}));
        const u = j?.data?.url; if (!u) throw new Error('tmpfiles não devolveu URL: ' + JSON.stringify(j).slice(0, 200));
        return u.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
      },
      apagar: async () => {}
    };
  }
  throw new Error('HOSPEDAGEM desconhecida: ' + tipo + ' (use r2, github ou tmpfiles)');
}
function sh(cmd, a, msg) {
  const r = spawnSync(cmd, a, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((msg || cmd + ' falhou') + ':\n' + (r.stderr || r.stdout));
  return r.stdout;
}
function parseData(s) {
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d)) throw new Error('data inválida, use "AAAA-MM-DD HH:MM": ' + s);
  return d;
}
function fmt(d) { return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
const espera = ms => new Promise(r => setTimeout(r, ms));
