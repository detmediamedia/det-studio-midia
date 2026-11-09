/** Carrega variáveis do .env na raiz (sem dependências). */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = path.join(ROOT, '.env');
if (existsSync(p)) {
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
export function precisa(nome, dica) {
  if (!process.env[nome]) { console.error(`✗ falta ${nome} no .env. ${dica || ''}`); process.exit(1); }
  return process.env[nome];
}
