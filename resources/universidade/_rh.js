// Helpers da área de RH da Universidade (trilhas por cargo, cursos/versões, registros).
// Arquivo com "_" não vira rota (ver config/resources.js).
//
// Permissões:
//   15004 = RH (monta trilhas, cursos, versões, lança registros)
//   15005 = Conformidade — só consulta (Qualidade, gestores, auditoria)
//   15003 = Admin da Universidade · 0 = admin universal (requirePerm já libera)

const path = require('path');
const Auditoria = require('../../services/auditoria');

const LER = [15004, 15005, 15003];
const ESCREVER = [15004, 15003];

const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

const requirePerm = (app, perms) => require('../../middlewares/requirePerm')(app)(perms);

const trim = (v) => String(v == null ? '' : v).trim();
const txt = (v, max = 4000) => { const s = trim(v); return s ? s.slice(0, max) : null; };
const int = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const dataISO = (v) => { const s = trim(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

const usuario = (req) => (req.user && req.user[0]) || {};

function audit(app, req, acao, entidade, entidadeId, descricao, depois) {
  return Auditoria.registrar(app, {
    modulo: 'Universidade', submodulo: 'RH', acao, severidade: 'INFO', req,
    entidade, entidadeId: entidadeId == null ? null : String(entidadeId), descricao, depois
  });
}

// Remove os aliases UPPERCASE que o services/pg.js adiciona em cada linha.
function limpa(row) {
  if (!row || typeof row !== 'object') return row;
  const o = {};
  for (const k of Object.keys(row)) if (k !== k.toUpperCase() || !(k.toLowerCase() in row)) o[k] = row[k];
  return o;
}

// snake_case → camelCase (resposta da API no padrão do front).
function camel(row) {
  const o = {};
  for (const [k, v] of Object.entries(limpa(row))) o[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return o;
}

const SITUACOES = ['em_dia', 'a_vencer', 'pendente', 'atrasado', 'vencido', 'desatualizado', 'dispensado'];
const CONFORMES = ['em_dia', 'a_vencer', 'dispensado'];
const IRREGULARES = ['atrasado', 'vencido', 'desatualizado'];

// Situação geral da pessoa a partir dos contadores dos requisitos obrigatórios.
function situacaoGeral(c) {
  if (!c.total) return 'sem_trilha';
  if ((c.atrasado || 0) + (c.vencido || 0) + (c.desatualizado || 0) > 0) return 'irregular';
  if (c.pendente) return 'pendente';
  return 'em_dia';
}

module.exports = {
  LER, ESCREVER, UPLOAD_ROOT, requirePerm, trim, txt, int, num, dataISO, usuario, audit,
  limpa, camel, SITUACOES, CONFORMES, IRREGULARES, situacaoGeral
};
