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

// ---------------------------------------------------------------- colaborador do usuário logado
// Pelo vínculo da sincronização (user_id) ou pelo e-mail do login.
async function colaboradorDoUsuario(Pg, u) {
  const uid = Number(u && (u.ID || u.id)) || 0;
  const email = String((u && (u.EMAIL || u.email)) || '');
  if (!uid && !email) return null;
  const r = await Pg.connectAndQuery(`
    SELECT c.id, c.cpf, c.nome, c.depto_codigo, c.ativo FROM tab_uni_colaborador c
     WHERE c.user_id = @uid OR (COALESCE(c.email, '') <> '' AND lower(c.email) = lower(@email))
     ORDER BY (c.user_id = @uid) DESC NULLS LAST, c.ativo DESC
     LIMIT 1`, { uid, email });
  return r[0] || null;
}

// ---------------------------------------------------------------- gestor = responsável do setor no Protheus
// Setores em que a pessoa (CPF) é responsável ou 2º responsável (SQB010), mais os setores
// abaixo deles na hierarquia (QB_DEPSUP). nivel 0 = setor direto.
async function setoresDoGestor(Pg, cpf) {
  if (!cpf) return [];
  return Pg.connectAndQuery(`
    WITH RECURSIVE base AS (
      SELECT codigo FROM tab_uni_departamento
       WHERE ativo AND (resp_cpf = @cpf OR resp2_cpf = @cpf)
    ), arvore AS (
      SELECT codigo, 0 AS nivel FROM base
      UNION
      SELECT d.codigo, a.nivel + 1
        FROM tab_uni_departamento d JOIN arvore a ON d.depto_sup = a.codigo
       WHERE d.ativo AND a.nivel < 8
    )
    SELECT d.codigo, d.descricao, MIN(a.nivel)::int AS nivel,
           (SELECT count(*) FROM tab_uni_colaborador c WHERE c.ativo AND c.depto_codigo = d.codigo)::int AS pessoas
      FROM arvore a JOIN tab_uni_departamento d ON d.codigo = a.codigo
     GROUP BY d.codigo, d.descricao
     ORDER BY MIN(a.nivel), d.descricao`, { cpf });
}

// ---------------------------------------------------------------- lista de colaboradores c/ placar
// Usada pelo RH (todos) e pelo gestor (só os setores dele: deptos = [códigos]).
async function consultaColaboradores(Pg, { q, depto, cargo, inativos, deptos, excluirId } = {}) {
  const filtros = [];
  const params = {};
  if (!inativos) filtros.push('c.ativo');
  if (q) {
    const dig = String(q).replace(/\D/g, '');
    filtros.push(`(c.nome ILIKE @q OR c.email ILIKE @q OR c.cargo_desc ILIKE @q${dig.length >= 3 ? ' OR c.matricula LIKE @dig OR c.cpf LIKE @dig' : ''})`);
    params.q = `%${q}%`;
    if (dig.length >= 3) params.dig = `%${dig}%`;
  }
  if (depto) { filtros.push('c.depto_desc = @depto'); params.depto = depto; }
  if (cargo) { filtros.push('c.cargo_codigo = @cargo'); params.cargo = cargo; }
  if (Array.isArray(deptos)) { filtros.push('c.depto_codigo = ANY(@deptos::text[])'); params.deptos = deptos; }
  if (excluirId) { filtros.push('c.id <> @excluir'); params.excluir = excluirId; }

  const rows = await Pg.connectAndQuery(`
    SELECT c.id, c.nome, c.filial, c.matricula, c.email, c.cargo_codigo, c.cargo_desc, c.depto_codigo, c.depto_desc,
           c.admissao::text AS admissao, c.cargo_desde::text AS cargo_desde, c.ativo, c.situacao AS situacao_folha,
           (c.user_id IS NOT NULL) AS tem_login,
           count(s.id)::int AS total,
           count(*) FILTER (WHERE s.situacao = 'em_dia')::int        AS em_dia,
           count(*) FILTER (WHERE s.situacao = 'a_vencer')::int      AS a_vencer,
           count(*) FILTER (WHERE s.situacao = 'pendente')::int      AS pendente,
           count(*) FILTER (WHERE s.situacao = 'atrasado')::int      AS atrasado,
           count(*) FILTER (WHERE s.situacao = 'vencido')::int       AS vencido,
           count(*) FILTER (WHERE s.situacao = 'desatualizado')::int AS desatualizado,
           count(*) FILTER (WHERE s.situacao = 'dispensado')::int    AS dispensado,
           MIN(s.prazo) FILTER (WHERE s.situacao IN ('pendente','atrasado'))::text AS proximo_prazo,
           (SELECT count(*) FROM vw_uni_reprovacao rp WHERE rp.colaborador_id = c.id)::int AS reprovacoes
      FROM tab_uni_colaborador c
      LEFT JOIN vw_uni_requisito_situacao s ON s.colaborador_id = c.id AND s.ativo AND s.obrigatorio
     ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
     GROUP BY c.id
     ORDER BY c.nome`, params);
  return rows.map(r => ({ ...camel(r), situacaoGeral: situacaoGeral(r) }));
}

// ---------------------------------------------------------------- reprovações (indicador)
// Por colaborador e por curso. Denominador da taxa = provas finalizadas + lançamentos válidos.
async function indicadorReprovacoes(Pg, { de, ate, deptos } = {}) {
  const fr = ['TRUE'];
  const params = {};
  if (de) { fr.push('rp.data >= @de'); params.de = de; }
  if (ate) { fr.push('rp.data <= @ate'); params.ate = ate; }
  if (Array.isArray(deptos)) { fr.push('c.depto_codigo = ANY(@deptos::text[])'); params.deptos = deptos; }
  const ft = ['t.finalizada_em IS NOT NULL'];
  const fg = ['NOT r.anulado'];
  if (de) { ft.push('t.finalizada_em::date >= @de'); fg.push('r.data_realizacao >= @de'); }
  if (ate) { ft.push('t.finalizada_em::date <= @ate'); fg.push('r.data_realizacao <= @ate'); }
  if (Array.isArray(deptos)) { ft.push('c.depto_codigo = ANY(@deptos::text[])'); fg.push('c.depto_codigo = ANY(@deptos::text[])'); }

  const [lista, porColab, porCurso] = await Promise.all([
    Pg.connectAndQuery(`
      SELECT rp.ref, rp.fonte, rp.data::text AS data, rp.nota, rp.nota_minima, rp.lote_id,
             c.id AS colaborador_id, c.nome, c.matricula, c.depto_desc, c.cargo_desc,
             cu.id AS curso_id, cu.codigo AS curso_codigo, cu.titulo AS curso_titulo
        FROM vw_uni_reprovacao rp
        JOIN tab_uni_colaborador c ON c.id = rp.colaborador_id
        JOIN tab_uni_curso cu      ON cu.id = rp.curso_id
       WHERE ${fr.join(' AND ')}
       ORDER BY rp.data DESC NULLS LAST
       LIMIT 500`, params),
    Pg.connectAndQuery(`
      SELECT c.id AS colaborador_id, c.nome, c.matricula, c.depto_desc, c.cargo_desc,
             count(*)::int AS reprovacoes, count(DISTINCT rp.curso_id)::int AS cursos, MAX(rp.data)::text AS ultima,
             string_agg(DISTINCT cu.titulo, ' · ') AS treinamentos
        FROM vw_uni_reprovacao rp
        JOIN tab_uni_colaborador c ON c.id = rp.colaborador_id
        JOIN tab_uni_curso cu      ON cu.id = rp.curso_id
       WHERE ${fr.join(' AND ')}
       GROUP BY c.id
       ORDER BY reprovacoes DESC, c.nome`, params),
    Pg.connectAndQuery(`
      WITH av AS (
        SELECT m.curso_id, count(*)::int AS n
          FROM tab_uni_tentativa t
          JOIN tab_uni_matricula m ON m.id = t.matricula_id
          JOIN tab_uni_colaborador c ON c.user_id = m.user_id
         WHERE ${ft.join(' AND ')}
         GROUP BY m.curso_id
        UNION ALL
        SELECT r.curso_id, count(*)::int
          FROM tab_uni_registro r JOIN tab_uni_colaborador c ON c.id = r.colaborador_id
         WHERE ${fg.join(' AND ')}
         GROUP BY r.curso_id
      ), tot AS (SELECT curso_id, SUM(n)::int AS avaliacoes FROM av GROUP BY curso_id),
      rep AS (
        SELECT rp.curso_id, count(*)::int AS reprovacoes, count(DISTINCT rp.colaborador_id)::int AS pessoas
          FROM vw_uni_reprovacao rp JOIN tab_uni_colaborador c ON c.id = rp.colaborador_id
         WHERE ${fr.join(' AND ')}
         GROUP BY rp.curso_id)
      SELECT cu.id AS curso_id, cu.codigo, cu.titulo, COALESCE(tot.avaliacoes, 0) AS avaliacoes,
             COALESCE(rep.reprovacoes, 0) AS reprovacoes, COALESCE(rep.pessoas, 0) AS pessoas,
             CASE WHEN COALESCE(tot.avaliacoes, 0) > 0
                  THEN ROUND(100.0 * COALESCE(rep.reprovacoes, 0) / tot.avaliacoes, 1) END AS taxa
        FROM tab_uni_curso cu
        LEFT JOIN tot ON tot.curso_id = cu.id
        LEFT JOIN rep ON rep.curso_id = cu.id
       WHERE COALESCE(tot.avaliacoes, 0) > 0 OR COALESCE(rep.reprovacoes, 0) > 0
       ORDER BY reprovacoes DESC, taxa DESC NULLS LAST, cu.titulo`, params)
  ]);
  const totalAval = porCurso.reduce((a, x) => a + Number(x.avaliacoes || 0), 0);
  const totalRep = porCurso.reduce((a, x) => a + Number(x.reprovacoes || 0), 0);
  return {
    resumo: {
      avaliacoes: totalAval, reprovacoes: totalRep, pessoas: porColab.length,
      taxa: totalAval ? Math.round((totalRep / totalAval) * 1000) / 10 : null
    },
    porColaborador: porColab.map(camel),
    porCurso: porCurso.map(x => ({ ...camel(x), taxa: x.taxa == null ? null : Number(x.taxa) })),
    lista: lista.map(camel)
  };
}

module.exports = {
  LER, ESCREVER, UPLOAD_ROOT, requirePerm, trim, txt, int, num, dataISO, usuario, audit,
  limpa, camel, SITUACOES, CONFORMES, IRREGULARES, situacaoGeral,
  normalizarRegras, validarRegras, gravarRegrasTrilha, definirTrilhasDaChave, VIA,
  colaboradorDoUsuario, setoresDoGestor, consultaColaboradores, indicadorReprovacoes
};
