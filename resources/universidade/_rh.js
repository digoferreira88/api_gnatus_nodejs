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

// ---------------------------------------------------------------- regras cargo/setor (migration 141)
// Normaliza [{cargoCodigo, deptoCodigo}] — ao menos um dos dois; remove repetidas.
function normalizarRegras(lista) {
  const vistos = new Set();
  const out = [];
  for (const r of Array.isArray(lista) ? lista : []) {
    const cargo = trim(r && r.cargoCodigo) || null;
    const depto = trim(r && r.deptoCodigo) || null;
    if (!cargo && !depto) continue;
    const k = `${cargo || ''}|${depto || ''}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push({ cargo, depto });
  }
  return out;
}

// Confere se cargos e setores existem no espelho. Devolve mensagem de erro ou null.
async function validarRegras(cli, regras) {
  const cargos = [...new Set(regras.map(r => r.cargo).filter(Boolean))];
  const deptos = [...new Set(regras.map(r => r.depto).filter(Boolean))];
  if (cargos.length) {
    const r = await cli.query(`SELECT codigo FROM tab_uni_cargo WHERE codigo = ANY($1::text[])`, [cargos]);
    const ok = new Set(r.rows.map(x => x.codigo));
    const falta = cargos.filter(c => !ok.has(c));
    if (falta.length) return `Cargo não encontrado: ${falta.join(', ')} (sincronize com o Protheus).`;
  }
  if (deptos.length) {
    const r = await cli.query(`SELECT codigo FROM tab_uni_departamento WHERE codigo = ANY($1::text[])`, [deptos]);
    const ok = new Set(r.rows.map(x => x.codigo));
    const falta = deptos.filter(c => !ok.has(c));
    if (falta.length) return `Setor não encontrado: ${falta.join(', ')} (sincronize com o Protheus).`;
  }
  return null;
}

// Troca as regras de UMA trilha pelo conjunto informado. Regra que continua mantém a
// data de criação (é dela que conta o prazo de quem já estava no cargo/setor).
async function gravarRegrasTrilha(cli, trilhaId, regras, userId) {
  const atuais = await cli.query(
    `SELECT id, COALESCE(cargo_codigo, '') AS c, COALESCE(depto_codigo, '') AS d FROM tab_uni_trilha_regra WHERE trilha_id = $1`, [trilhaId]);
  const quer = new Set(regras.map(r => `${r.cargo || ''}|${r.depto || ''}`));
  const tem = new Set(atuais.rows.map(r => `${r.c}|${r.d}`));
  const remover = atuais.rows.filter(r => !quer.has(`${r.c}|${r.d}`)).map(r => r.id);
  if (remover.length) await cli.query(`DELETE FROM tab_uni_trilha_regra WHERE id = ANY($1::int[])`, [remover]);
  for (const r of regras) {
    if (tem.has(`${r.cargo || ''}|${r.depto || ''}`)) continue;
    await cli.query(
      `INSERT INTO tab_uni_trilha_regra (trilha_id, cargo_codigo, depto_codigo, criado_por) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`, [trilhaId, r.cargo, r.depto, userId || null]);
  }
  return { removidas: remover.length };
}

// Define quais trilhas valem para UMA chave (cargo, setor) — qualquer dos dois pode ser null.
async function definirTrilhasDaChave(cli, cargo, depto, trilhaIds, userId) {
  await cli.query(`
    DELETE FROM tab_uni_trilha_regra
     WHERE COALESCE(cargo_codigo, '') = COALESCE($1, '') AND COALESCE(depto_codigo, '') = COALESCE($2, '')
       AND NOT (trilha_id = ANY($3::int[]))`, [cargo, depto, trilhaIds]);
  if (trilhaIds.length) {
    await cli.query(`
      INSERT INTO tab_uni_trilha_regra (trilha_id, cargo_codigo, depto_codigo, criado_por)
      SELECT t.id, $1::varchar, $2::varchar, $4::int FROM tab_uni_trilha t WHERE t.id = ANY($3::int[])
      ON CONFLICT DO NOTHING`, [cargo, depto, trilhaIds, userId || null]);
  }
}

const VIA = { todos: 'todos', cargo: 'cargo', setor: 'setor', cargo_setor: 'cargo+setor' };

module.exports = {
  LER, ESCREVER, UPLOAD_ROOT, requirePerm, trim, txt, int, num, dataISO, usuario, audit,
  limpa, camel, SITUACOES, CONFORMES, IRREGULARES, situacaoGeral,
  normalizarRegras, validarRegras, gravarRegrasTrilha, definirTrilhasDaChave, VIA
};
