// services/ciospMidia.js — fotos dos produtos e catálogos em PDF do CIOSP.
//
// Os arquivos ficam em disco (fora do repositório), com o nome = sha256 do conteúdo.
// Assim o mesmo arquivo enviado duas vezes ocupa um lugar só, e o celular pode guardar
// para sempre: trocar a foto gera outro nome. Em produção o nginx do app do estande
// entrega direto da pasta; na intranet, GET /ciosp/midia-arquivo/:arquivo.
//
// A foto chega já reduzida pelo navegador (lado maior 1200 px, WebP) — a API não
// ganha dependência nativa de imagem.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const PADRAO_NOME = /^[a-f0-9]{64}\.(webp|jpg|png|pdf)$/;

function dirMidia() {
  return process.env.CIOSP_MIDIA_DIR || path.resolve(__dirname, '../storage/ciosp');
}

function nomeArquivo(buffer, mime) {
  const ext = EXT[mime];
  if (!ext) throw new Error('tipo de arquivo não aceito (use WebP, JPEG, PNG ou PDF)');
  return `${crypto.createHash('sha256').update(buffer).digest('hex')}.${ext}`;
}

const nomeValido = (nome) => PADRAO_NOME.test(String(nome || ''));
const mimeDoNome = (nome) => MIME[String(nome).split('.').pop()];

async function gravar(buffer, mime) {
  const arquivo = nomeArquivo(buffer, mime);
  const dir = dirMidia();
  await fs.promises.mkdir(dir, { recursive: true });
  const destino = path.join(dir, arquivo);
  if (fs.existsSync(destino)) return { arquivo, bytes: buffer.length, novo: false };
  // grava num temporário e renomeia: um download concorrente nunca vê arquivo pela metade
  const tmp = `${destino}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, buffer);
  await fs.promises.rename(tmp, destino);
  return { arquivo, bytes: buffer.length, novo: true };
}

async function apagar(arquivo) {
  if (!nomeValido(arquivo)) return;
  await fs.promises.rm(path.join(dirMidia(), arquivo), { force: true });
}

// Foto de uma linha da tabela: a específica da linha, senão a ligada ao código impresso.
function fotoDaLinha(linha, fotos) {
  if (linha.foto_id) return linha.foto_id;
  const cod = String(linha.codigo || '').trim().toUpperCase();
  if (!cod) return null;
  const f = (fotos || []).find(x => String(x.codigo || '').trim().toUpperCase() === cod);
  return f ? f.id : null;
}

module.exports = { dirMidia, nomeArquivo, nomeValido, mimeDoNome, gravar, apagar, fotoDaLinha };
