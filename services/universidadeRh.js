// Universidade · RH — espelho de cargos e colaboradores do Protheus + requisitos de treinamento.
//
// Fluxo (job diário e botão "Sincronizar agora"):
//   1) SQ3010 → tab_uni_cargo                       (cargos)
//   2) SRA010 → tab_uni_colaborador (chave = CPF)   (admissão, mudança de cargo, desligamento
//                                                     viram eventos em tab_uni_colaborador_evento)
//   3) liga colaborador ↔ usuário da intranet pelo e-mail (p/ "Minha trilha" e EAD)
//   4) recalcula tab_uni_requisito: cargo → trilhas → cursos (+ trilhas "para todos")
//
// Protheus é só LIDO. Nada é apagado: requisito que deixa de valer fica ativo=false.

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const ymd = (v) => {
  const s = trim(v);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};
const hojeISO = () => {
  // data de São Paulo (a VPS roda em UTC)
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  return p.slice(0, 10);
};

// Situações de um requisito (ver vw_uni_requisito_situacao na migration 140).
const CONFORMES = ['em_dia', 'a_vencer', 'dispensado'];
const IRREGULARES = ['atrasado', 'vencido', 'desatualizado'];

async function sincronizarCargos(app) {
  const { Pg, Protheus } = app.services;
  const rows = await Protheus.connectAndQuery(`
    SELECT RTRIM(Q3_CARGO) codigo, MAX(RTRIM(Q3_DESCSUM)) descricao
      FROM SQ3010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND RTRIM(Q3_CARGO) <> ''
     GROUP BY RTRIM(Q3_CARGO)`);
  const dados = rows.map(r => ({ codigo: trim(r.codigo), descricao: trim(r.descricao) || null }));
  if (!dados.length) return { total: 0, desativados: 0 };
  const r = await Pg.connectAndQuery(`
    WITH x AS (SELECT * FROM jsonb_to_recordset(@dados::jsonb) AS x(codigo text, descricao text)),
    up AS (
      INSERT INTO tab_uni_cargo (codigo, descricao, ativo, sincronizado_em)
      SELECT codigo, descricao, TRUE, NOW() FROM x
      ON CONFLICT (codigo) DO UPDATE SET descricao = EXCLUDED.descricao, ativo = TRUE, sincronizado_em = NOW()
      RETURNING 1),
    off AS (
      UPDATE tab_uni_cargo c SET ativo = FALSE
       WHERE c.ativo AND NOT EXISTS (SELECT 1 FROM x WHERE x.codigo = c.codigo)
      RETURNING 1)
    SELECT (SELECT count(*) FROM up)::int AS total, (SELECT count(*) FROM off)::int AS desativados`,
    { dados: JSON.stringify(dados) });
  return { total: r[0].total, desativados: r[0].desativados };
}

async function lerColaboradoresProtheus(app) {
  const { Protheus } = app.services;
  const rows = await Protheus.connectAndQuery(`
    SELECT RTRIM(sra.RA_FILIAL) filial, RTRIM(sra.RA_MAT) matricula, RTRIM(sra.RA_CIC) cpf,
           RTRIM(COALESCE(NULLIF(RTRIM(sra.RA_NOMECMP), ''), sra.RA_NOME)) nome,
           RTRIM(sra.RA_EMAIL) email,
           RTRIM(sra.RA_CARGO) cargo,   RTRIM(sq3.Q3_DESCSUM) cargo_desc,
           RTRIM(sra.RA_CODFUNC) funcao, RTRIM(srj.RJ_DESC) funcao_desc,
           RTRIM(sra.RA_DEPTO) depto,  LTRIM(RTRIM(sqb.QB_DESCRIC)) depto_desc,
           RTRIM(sra.RA_CC) cc,
           sra.RA_ADMISSA admissao, sra.RA_DEMISSA demissao, RTRIM(sra.RA_SITFOLH) situacao
      FROM SRA010 sra WITH (NOLOCK)
      LEFT JOIN SQ3010 sq3 WITH (NOLOCK) ON RTRIM(sq3.Q3_CARGO) = RTRIM(sra.RA_CARGO) AND sq3.D_E_L_E_T_ <> '*'
      LEFT JOIN SRJ010 srj WITH (NOLOCK) ON RTRIM(srj.RJ_FUNCAO) = RTRIM(sra.RA_CODFUNC) AND srj.D_E_L_E_T_ <> '*'
      LEFT JOIN SQB010 sqb WITH (NOLOCK) ON RTRIM(sqb.QB_DEPTO) = RTRIM(sra.RA_DEPTO) AND sqb.D_E_L_E_T_ <> '*'
     WHERE sra.D_E_L_E_T_ <> '*'`);

  // 1 registro por filial+matrícula (join com SQ3/SRJ/SQB pode duplicar)
  const porMat = new Map();
  for (const r of rows) {
    const k = `${trim(r.filial)}|${trim(r.matricula)}`;
    if (!porMat.has(k)) porMat.set(k, r);
  }

  // 1 pessoa por CPF: o registro ATIVO mais recente; sem ativo, a admissão mais recente.
  const porPessoa = new Map();
  for (const r of porMat.values()) {
    const cpf = soDig(r.cpf);
    const chave = cpf || `F${trim(r.filial)}-${trim(r.matricula)}`;
    const ativo = trim(r.situacao) !== 'D' && !trim(r.demissao);
    const p = {
      chave, cpf: cpf || null, filial: trim(r.filial), matricula: trim(r.matricula),
      nome: trim(r.nome) || '(sem nome)', email: trim(r.email).toLowerCase() || null,
      cargo_codigo: trim(r.cargo) || null, cargo_desc: trim(r.cargo_desc) || null,
      funcao_codigo: trim(r.funcao) || null, funcao_desc: trim(r.funcao_desc) || null,
      depto_codigo: trim(r.depto) || null, depto_desc: trim(r.depto_desc) || null,
      centro_custo: trim(r.cc) || null,
      admissao: ymd(r.admissao), demissao: ymd(r.demissao), situacao: trim(r.situacao) || null,
      ativo
    };
    const atual = porPessoa.get(chave);
    const melhor = !atual
      || (p.ativo && !atual.ativo)
      || (p.ativo === atual.ativo && String(p.admissao || '') > String(atual.admissao || ''));
    if (melhor) porPessoa.set(chave, p);
  }
  return [...porPessoa.values()];
}

async function sincronizarColaboradores(app) {
  const { Pg } = app.services;
  const pessoas = await lerColaboradoresProtheus(app);
  const existentes = await Pg.connectAndQuery(
    `SELECT id, chave, cargo_codigo, cargo_desc, ativo FROM tab_uni_colaborador`);
  const mapa = new Map(existentes.map(e => [e.chave, e]));
  const primeiraCarga = existentes.length === 0;
  const hoje = hojeISO();

  const gravar = [];
  const eventos = [];
  const cont = { admissoes: 0, mudancasCargo: 0, desligamentos: 0, readmissoes: 0, cargaInicial: 0 };

  for (const p of pessoas) {
    const ex = mapa.get(p.chave);
    if (!ex) {
      if (!p.ativo) continue;                 // histórico de desligados não interessa
      p.cargo_desde = p.admissao || hoje;
      gravar.push(p);
      if (primeiraCarga) {
        cont.cargaInicial++;
        eventos.push({ chave: p.chave, tipo: 'carga_inicial', de: null, para: cargoTxt(p), data: p.admissao });
      } else {
        cont.admissoes++;
        eventos.push({ chave: p.chave, tipo: 'admissao', de: null, para: cargoTxt(p), data: p.admissao || hoje });
      }
      continue;
    }
    p.cargo_desde = null;                      // mantém o que está gravado
    if (ex.ativo && !p.ativo) {
      cont.desligamentos++;
      eventos.push({ chave: p.chave, tipo: 'desligamento', de: cargoTxt(ex), para: null, data: p.demissao || hoje });
    } else if (!ex.ativo && p.ativo) {
      cont.readmissoes++;
      p.cargo_desde = p.admissao || hoje;
      eventos.push({ chave: p.chave, tipo: 'readmissao', de: null, para: cargoTxt(p), data: p.admissao || hoje });
    } else if (p.ativo && ex.cargo_codigo && p.cargo_codigo && ex.cargo_codigo !== p.cargo_codigo) {
      cont.mudancasCargo++;
      p.cargo_desde = hoje;
      eventos.push({ chave: p.chave, tipo: 'mudanca_cargo', de: cargoTxt(ex), para: cargoTxt(p), data: hoje });
    }
    gravar.push(p);
  }

  if (gravar.length) {
    await Pg.connectAndQuery(`
      INSERT INTO tab_uni_colaborador AS c
        (chave, cpf, filial, matricula, nome, email, cargo_codigo, cargo_desc, funcao_codigo, funcao_desc,
         depto_codigo, depto_desc, centro_custo, admissao, demissao, situacao, ativo, cargo_desde, sincronizado_em)
      SELECT chave, cpf, filial, matricula, nome, email, cargo_codigo, cargo_desc, funcao_codigo, funcao_desc,
             depto_codigo, depto_desc, centro_custo, admissao, demissao, situacao, ativo, cargo_desde, NOW()
        FROM jsonb_to_recordset(@dados::jsonb) AS x(
             chave text, cpf text, filial text, matricula text, nome text, email text,
             cargo_codigo text, cargo_desc text, funcao_codigo text, funcao_desc text,
             depto_codigo text, depto_desc text, centro_custo text,
             admissao date, demissao date, situacao text, ativo boolean, cargo_desde date)
      ON CONFLICT (chave) DO UPDATE SET
        cpf = EXCLUDED.cpf, filial = EXCLUDED.filial, matricula = EXCLUDED.matricula, nome = EXCLUDED.nome,
        email = EXCLUDED.email, cargo_codigo = EXCLUDED.cargo_codigo, cargo_desc = EXCLUDED.cargo_desc,
        funcao_codigo = EXCLUDED.funcao_codigo, funcao_desc = EXCLUDED.funcao_desc,
        depto_codigo = EXCLUDED.depto_codigo, depto_desc = EXCLUDED.depto_desc, centro_custo = EXCLUDED.centro_custo,
        admissao = EXCLUDED.admissao, demissao = EXCLUDED.demissao, situacao = EXCLUDED.situacao,
        ativo = EXCLUDED.ativo, cargo_desde = COALESCE(EXCLUDED.cargo_desde, c.cargo_desde),
        sincronizado_em = NOW()`,
      { dados: JSON.stringify(gravar) });
  }

  if (eventos.length) {
    await Pg.connectAndQuery(`
      INSERT INTO tab_uni_colaborador_evento (colaborador_id, tipo, de, para, data)
      SELECT c.id, x.tipo, x.de, x.para, x.data
        FROM jsonb_to_recordset(@dados::jsonb) AS x(chave text, tipo text, de text, para text, data date)
        JOIN tab_uni_colaborador c ON c.chave = x.chave`,
      { dados: JSON.stringify(eventos) });
  }

  // Liga ao usuário da intranet pelo e-mail (o e-mail do usuário é único).
  const lig = await Pg.connectAndQuery(`
    UPDATE tab_uni_colaborador c SET user_id = u.id
      FROM tab_intranet_usr u
     WHERE c.user_id IS NULL AND COALESCE(c.email, '') <> '' AND lower(u.email) = lower(c.email)
    RETURNING c.id`);

  return {
    lidos: pessoas.length,
    ativos: pessoas.filter(p => p.ativo).length,
    gravados: gravar.length,
    vinculadosLogin: lig.length,
    ...cont
  };
}

function cargoTxt(x) {
  const cod = trim(x.cargo_codigo);
  const desc = trim(x.cargo_desc);
  if (!cod && !desc) return null;
  return desc ? `${cod} · ${desc}` : cod;
}

// cargo → trilhas → cursos (+ trilhas "para todos"). Mantém a data em que a exigência
// nasceu (desde) enquanto ela continuar valendo; o prazo é desde + prazo_dias.
async function recalcularRequisitos(app) {
  const { Pg } = app.services;
  const r = await Pg.connectAndQuery(`
    WITH alvo AS (
      SELECT col.id AS colaborador_id, ti.curso_id,
             bool_or(ti.obrigatorio) AS obrigatorio,
             string_agg(DISTINCT t.codigo, ', ' ORDER BY t.codigo) AS origem,
             MIN(ti.prazo_dias) AS prazo_dias,
             MIN(GREATEST(
                   COALESCE(col.cargo_desde, col.admissao, CURRENT_DATE),
                   ti.criado_em::date,
                   CASE WHEN t.aplica_todos THEN t.criado_em::date ELSE ct.criado_em::date END)) AS desde
        FROM tab_uni_colaborador col
        JOIN tab_uni_trilha t ON t.ativo AND t.publico = 'interno'
        LEFT JOIN tab_uni_cargo_trilha ct ON ct.trilha_id = t.id AND ct.cargo_codigo = col.cargo_codigo
        JOIN tab_uni_trilha_item ti ON ti.trilha_id = t.id
        JOIN tab_uni_curso cu ON cu.id = ti.curso_id AND cu.ativo
       WHERE col.ativo AND (t.aplica_todos OR ct.trilha_id IS NOT NULL)
       GROUP BY col.id, ti.curso_id
    ), up AS (
      INSERT INTO tab_uni_requisito AS r (colaborador_id, curso_id, obrigatorio, origem, desde, prazo_dias, ativo)
      SELECT colaborador_id, curso_id, obrigatorio, origem, desde, prazo_dias, TRUE FROM alvo
      ON CONFLICT (colaborador_id, curso_id) DO UPDATE SET
        obrigatorio  = EXCLUDED.obrigatorio,
        origem       = EXCLUDED.origem,
        prazo_dias   = EXCLUDED.prazo_dias,
        desde        = CASE WHEN r.ativo THEN r.desde ELSE EXCLUDED.desde END,
        ativo        = TRUE,
        inativado_em = NULL,
        atualizado_em = CASE WHEN (r.obrigatorio, r.origem, r.prazo_dias, r.ativo)
                                  IS DISTINCT FROM (EXCLUDED.obrigatorio, EXCLUDED.origem, EXCLUDED.prazo_dias, TRUE)
                             THEN NOW() ELSE r.atualizado_em END
      RETURNING (xmax = 0) AS inserido
    ), off AS (
      UPDATE tab_uni_requisito r SET ativo = FALSE, inativado_em = NOW(), atualizado_em = NOW()
       WHERE r.ativo
         AND NOT EXISTS (SELECT 1 FROM alvo a WHERE a.colaborador_id = r.colaborador_id AND a.curso_id = r.curso_id)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM up WHERE inserido)::int AS novos,
           (SELECT count(*) FROM up)::int AS vigentes,
           (SELECT count(*) FROM off)::int AS inativados`);
  return { novos: r[0].novos, vigentes: r[0].vigentes, inativados: r[0].inativados };
}

let rodando = null;

// Sincronização completa. Serializada no processo (job e botão não rodam juntos).
async function sincronizar(app, { origem = 'manual', userId = null } = {}) {
  if (rodando) return rodando;
  rodando = (async () => {
    const { Pg } = app.services;
    const log = await Pg.connectAndQuery(
      `INSERT INTO tab_uni_sync_log (origem, executado_por) VALUES (@o, @u) RETURNING id`,
      { o: origem, u: userId });
    const logId = log[0].id;
    try {
      const cargos = await sincronizarCargos(app);
      const colaboradores = await sincronizarColaboradores(app);
      const requisitos = await recalcularRequisitos(app);
      const resumo = { cargos, colaboradores, requisitos };
      await Pg.connectAndQuery(
        `UPDATE tab_uni_sync_log SET concluido_em = NOW(), ok = TRUE, resumo = @r::jsonb WHERE id = @id`,
        { r: JSON.stringify(resumo), id: logId });
      return resumo;
    } catch (err) {
      await Pg.connectAndQuery(
        `UPDATE tab_uni_sync_log SET concluido_em = NOW(), ok = FALSE, erro = @e WHERE id = @id`,
        { e: String(err.message || err).slice(0, 2000), id: logId }).catch(() => {});
      throw err;
    }
  })();
  try { return await rodando; } finally { rodando = null; }
}

module.exports = {
  sincronizar, sincronizarCargos, sincronizarColaboradores, recalcularRequisitos,
  CONFORMES, IRREGULARES, hojeISO, trim, soDig
};
