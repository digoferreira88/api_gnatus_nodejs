const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);

// Status do SCR010 (alçada de aprovação)
const decodeStatusAprovacao = (s) => {
  switch (trim(s)) {
    case '02': return { codigo: 'LIBERADO',  label: 'Liberado',  cor: '#09A013' };
    case '03': return { codigo: 'PENDENTE',  label: 'Pendente',  cor: '#f5a500' };
    case '05': return { codigo: 'BLOQUEADO', label: 'Bloqueado', cor: '#8093ac' };
    case '06': return { codigo: 'REJEITADO', label: 'Rejeitado', cor: '#c9302c' };
    default:   return { codigo: trim(s),     label: trim(s),     cor: '#6b7a90' };
  }
};

const calcStatusSC7 = (r) => {
  const quant = toNumber(r.C7_QUANT);
  const quje = toNumber(r.C7_QUJE);
  const conapro = trim(r.C7_CONAPRO);
  const residuo = trim(r.C7_RESIDUO);
  const encer = trim(r.C7_ENCER);

  if (residuo === 'S') return { codigo: 'RESIDUO', label: 'Resíduo eliminado', cor: '#800080' };
  if (encer === 'E') return { codigo: 'ENCERRADO', label: 'Encerrado', cor: '#6b7a90' };
  if (conapro === 'B') return { codigo: 'BLOQUEADO', label: 'Bloqueado', cor: '#c9302c' };
  if (quant > 0 && quje >= quant) return { codigo: 'ATENDIDO_TOTAL', label: 'Totalmente atendido', cor: '#1e5fb5' };
  if (quje > 0) return { codigo: 'ENTREGA_PARCIAL', label: 'Entrega parcial', cor: '#f5a500' };
  if (conapro === 'L') return { codigo: 'LIBERADO', label: 'Liberado', cor: '#09A013' };
  return { codigo: 'EM_APROVACAO', label: 'Em aprovação', cor: '#e55a1a' };
};

module.exports = (app) => ({
  verb: 'get',
  route: '/pedidos',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { inicio, fim, status, fornecedor, comprador, pedido } = req.query;
    const numPedido = String(pedido || '').trim();

    const dtInicio = toProtheusDate(inicio);
    const dtFim = toProtheusDate(fim);

    if (!dtInicio || !dtFim) {
      return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });
    }

    const params = { inicio: dtInicio, fim: dtFim };
    const conds = [];
    if (fornecedor) {
      params.fornecedor = String(fornecedor);
      conds.push(`AND RTRIM(sc7.C7_FORNECE) = @fornecedor`);
    }
    if (comprador) {
      params.comprador = String(comprador);
      conds.push(`AND RTRIM(sc7.C7_USER) LIKE '%' + @comprador + '%'`);
    }
    // Nº do pedido: LIKE para aceitar tanto "025185" quanto "25185" (sem os
    // zeros à esquerda) ou um trecho do número.
    if (numPedido) {
      params.pedido = numPedido;
      conds.push(`AND RTRIM(sc7.C7_NUM) LIKE '%' + @pedido + '%'`);
    }

    const sql = `
      SELECT
        RTRIM(sc7.C7_FILIAL)  AS filial,
        RTRIM(sc7.C7_NUM)     AS numero,
        RTRIM(sc7.C7_ITEM)    AS item,
        RTRIM(sc7.C7_PRODUTO) AS produto,
        RTRIM(sc7.C7_DESCRI)  AS descricao,
        RTRIM(sc7.C7_UM)      AS unidade,
        sc7.C7_QUANT          AS quantidade,
        sc7.C7_QUJE           AS atendido,
        sc7.C7_PRECO          AS preco,
        sc7.C7_TOTAL          AS total,
        RTRIM(sc7.C7_LOCAL)   AS armazem,
        sc7.C7_EMISSAO        AS emissao,
        sc7.C7_DATPRF         AS dataPrevista,
        DATEDIFF(day, GETDATE(), sc7.C7_DATPRF) AS dias,
        RTRIM(sc7.C7_FORNECE) AS fornecedor,
        RTRIM(sc7.C7_LOJA)    AS fornecedorLoja,
        RTRIM(sa2.A2_NOME)    AS fornecedorNome,
        RTRIM(sc7.C7_NUMSC)   AS origemSC,
        RTRIM(sc7.C7_ITEMSC)  AS origemSCItem,
        RTRIM(sc7.C7_ZNUMPRO) AS origemProcesso,
        RTRIM(sc7.C7_CC)      AS centroCusto,
        RTRIM(sc7.C7_USER)    AS usuario,
        RTRIM(sc7.C7_COND)    AS condPag,
        RTRIM(sc7.C7_GRUPCOM) AS grupoAprov,
        RTRIM(sc7.C7_CONAPRO) AS conapro,
        RTRIM(sc7.C7_RESIDUO) AS residuo,
        RTRIM(sc7.C7_ENCER)   AS encer,
        RTRIM(sc7.C7_OBS)     AS observacao
      FROM SC7010 sc7 WITH (NOLOCK)
      LEFT JOIN SA2010 sa2 WITH (NOLOCK)
        ON sa2.A2_COD  = sc7.C7_FORNECE
       AND sa2.A2_LOJA = sc7.C7_LOJA
       AND sa2.D_E_L_E_T_ <> '*'
      WHERE sc7.D_E_L_E_T_ <> '*'
        AND sc7.C7_FILIAL = '01'
        ${numPedido ? '' : 'AND sc7.C7_EMISSAO BETWEEN @inicio AND @fim'}
        ${conds.join(' ')}
      ORDER BY sc7.C7_EMISSAO DESC, sc7.C7_NUM DESC, sc7.C7_ITEM
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);

      // Aprovações em SCR010 (CR_TIPO='PC')
      const numeros = [...new Set(rows.map(r => trim(r.numero)).filter(Boolean))];
      const aprovacoesPorNum = new Map();
      const usuariosCods = new Set();
      // Inclui codigo do COMPRADOR (C7_USER) na busca de nomes em SYS_USR
      rows.forEach(r => { const u = trim(r.usuario); if (u) usuariosCods.add(u); });
      const BATCH = 500;
      for (let i = 0; i < numeros.length; i += BATCH) {
        const slice = numeros.slice(i, i + BATCH);
        const inClause = slice.map((_, k) => `@n${k}`).join(',');
        const p = {};
        slice.forEach((n, k) => { p[`n${k}`] = n; });
        try {
          const aprs = await Protheus.connectAndQuery(
            `SELECT RTRIM(CR_NUM)     numero,
                    RTRIM(CR_NIVEL)   nivel,
                    RTRIM(CR_USER)    aprovador,
                    RTRIM(CR_USERLIB) liberadoPor,
                    CR_DATALIB        dataLib,
                    RTRIM(CR_STATUS)  status,
                    RTRIM(CR_GRUPO)   grupo,
                    RTRIM(CR_APROV)   aprov,
                    CR_TOTAL          total
               FROM SCR010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*'
                AND CR_FILIAL = '01'
                AND CR_TIPO = 'PC'
                AND CR_NUM IN (${inClause})
              ORDER BY CR_NUM, CR_NIVEL`,
            p
          );
          aprs.forEach(a => {
            const num = trim(a.numero);
            if (!aprovacoesPorNum.has(num)) aprovacoesPorNum.set(num, []);
            aprovacoesPorNum.get(num).push(a);
            if (trim(a.aprovador))   usuariosCods.add(trim(a.aprovador));
            if (trim(a.liberadoPor)) usuariosCods.add(trim(a.liberadoPor));
          });
        } catch (e) { console.warn('PC aprovacoes batch err:', e.message); }
      }

      // Fallback: para PCs sem aprovação direta (alçada SCR foi desativada em
      // 11/2025), busca a aprovação da SC de origem (C7_NUMSC ou C7_ZNUMPRO).
      // Marca como 'SC origem' no drawer para ficar transparente.
      const aprovacoesPorSc = new Map();   // scNum -> [lancamentos]
      const scsOrigem = new Set();
      rows.forEach(r => {
        const num = trim(r.numero);
        if (aprovacoesPorNum.has(num)) return; // já tem aprovação direta do PC
        const sc = trim(r.origemSC) || trim(r.origemProcesso);
        if (sc) scsOrigem.add(sc);
      });
      const scsArr = [...scsOrigem];
      for (let i = 0; i < scsArr.length; i += BATCH) {
        const slice = scsArr.slice(i, i + BATCH);
        const inClause = slice.map((_, k) => `@s${k}`).join(',');
        const p = {};
        slice.forEach((n, k) => { p[`s${k}`] = n; });
        try {
          const aprs = await Protheus.connectAndQuery(
            `SELECT RTRIM(CR_NUM)     numero,
                    RTRIM(CR_NIVEL)   nivel,
                    RTRIM(CR_USER)    aprovador,
                    RTRIM(CR_USERLIB) liberadoPor,
                    CR_DATALIB        dataLib,
                    RTRIM(CR_STATUS)  status,
                    RTRIM(CR_GRUPO)   grupo,
                    RTRIM(CR_APROV)   aprov,
                    CR_TOTAL          total
               FROM SCR010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*'
                AND CR_FILIAL = '01'
                AND CR_TIPO = 'SC'
                AND CR_NUM IN (${inClause})
              ORDER BY CR_NUM, CR_NIVEL`,
            p
          );
          aprs.forEach(a => {
            const num = trim(a.numero);
            if (!aprovacoesPorSc.has(num)) aprovacoesPorSc.set(num, []);
            aprovacoesPorSc.get(num).push(a);
            if (trim(a.aprovador))   usuariosCods.add(trim(a.aprovador));
            if (trim(a.liberadoPor)) usuariosCods.add(trim(a.liberadoPor));
          });
        } catch (e) { console.warn('PC SC origem batch err:', e.message); }
      }

      // 3o fallback: SAL010 — quando o PC ainda não tem aprovações via SCR
      // (próprio ou da SC), busca os aprovadores potenciais do grupo
      // (C7_GRUPCOM). Não revela QUEM efetivamente aprovou (Protheus não
      // grava após desativação do SCR), mas mostra a lista de quem PODE
      // aprovar pelo cadastro de alçadas.
      const aprovadoresPorGrupo = new Map(); // grupo -> [{ aprov, usr, nivel }]
      const gruposNeed = new Set();
      rows.forEach(r => {
        const num = trim(r.numero);
        if (aprovacoesPorNum.has(num)) return;
        const sc = trim(r.origemSC) || trim(r.origemProcesso);
        if (sc && aprovacoesPorSc.has(sc)) return;
        const grupo = trim(r.grupoAprov);
        if (grupo) gruposNeed.add(grupo);
      });
      const gruposArr = [...gruposNeed];
      for (let i = 0; i < gruposArr.length; i += BATCH) {
        const slice = gruposArr.slice(i, i + BATCH);
        const inClause = slice.map((_, k) => `@g${k}`).join(',');
        const p = {};
        slice.forEach((g, k) => { p[`g${k}`] = g; });
        try {
          const sals = await Protheus.connectAndQuery(
            `SELECT RTRIM(AL_COD)   grupo,
                    RTRIM(AL_DESC)  descrGrupo,
                    RTRIM(AL_ITEM)  item,
                    RTRIM(AL_APROV) aprov,
                    RTRIM(AL_USER)  usuario,
                    RTRIM(AL_NIVEL) nivel,
                    RTRIM(AL_DOCPC) docPc,
                    RTRIM(AL_LIBAPR) libApr
               FROM SAL010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*'
                AND AL_FILIAL = '01'
                AND AL_COD IN (${inClause})
              ORDER BY AL_COD, AL_NIVEL, AL_ITEM`,
            p
          );
          sals.forEach(s => {
            const g = trim(s.grupo);
            if (!aprovadoresPorGrupo.has(g)) aprovadoresPorGrupo.set(g, { descrGrupo: trim(s.descrGrupo), aprovadores: [] });
            aprovadoresPorGrupo.get(g).aprovadores.push(s);
            if (trim(s.usuario)) usuariosCods.add(trim(s.usuario));
          });
        } catch (e) { console.warn('PC SAL grupo batch err:', e.message); }
      }

      const nomesUsr = new Map();
      const cods = [...usuariosCods];
      if (cods.length > 0) {
        try {
          for (let i = 0; i < cods.length; i += BATCH) {
            const slice = cods.slice(i, i + BATCH);
            const inUsr = slice.map((_, k) => `@u${k}`).join(',');
            const p = {};
            slice.forEach((c, k) => { p[`u${k}`] = c; });
            const usrs = await Protheus.connectAndQuery(
              `SELECT RTRIM(USR_ID) id, RTRIM(USR_NOME) nome FROM SYS_USR WHERE USR_ID IN (${inUsr})`,
              p
            );
            usrs.forEach(u => nomesUsr.set(trim(u.id), trim(u.nome)));
          }
        } catch (e) { console.warn('PC nomes usuarios err:', e.message); }
      }

      const statusList = status ? String(status).split(',').map(s => s.trim()).filter(Boolean) : null;

      const dados = rows
        .map((r) => {
          const st = calcStatusSC7({
            C7_QUANT: r.quantidade,
            C7_QUJE: r.atendido,
            C7_CONAPRO: r.conapro,
            C7_RESIDUO: r.residuo,
            C7_ENCER: r.encer
          });
          // Cascata: 1) SCR direto do PC  →  2) SCR da SC origem  →  3) aprovadores potenciais via SAL do grupo
          let rawAprs = aprovacoesPorNum.get(trim(r.numero)) || [];
          let origemAprovacao = null;
          let aprovacoes = [];
          if (rawAprs.length > 0) {
            aprovacoes = rawAprs.map(a => ({
              nivel: trim(a.nivel),
              aprovadorCod: trim(a.aprovador),
              aprovadorNome: nomesUsr.get(trim(a.aprovador)) || '',
              liberadoPorCod: trim(a.liberadoPor),
              liberadoPorNome: nomesUsr.get(trim(a.liberadoPor)) || '',
              dataLib: trim(a.dataLib),
              status: decodeStatusAprovacao(a.status),
              grupo: trim(a.grupo),
              valor: toNumber(a.total)
            }));
          } else {
            const sc = trim(r.origemSC) || trim(r.origemProcesso);
            if (sc && aprovacoesPorSc.has(sc)) {
              origemAprovacao = { tipo: 'SC_ORIGEM', numero: sc };
              aprovacoes = aprovacoesPorSc.get(sc).map(a => ({
                nivel: trim(a.nivel),
                aprovadorCod: trim(a.aprovador),
                aprovadorNome: nomesUsr.get(trim(a.aprovador)) || '',
                liberadoPorCod: trim(a.liberadoPor),
                liberadoPorNome: nomesUsr.get(trim(a.liberadoPor)) || '',
                dataLib: trim(a.dataLib),
                status: decodeStatusAprovacao(a.status),
                grupo: trim(a.grupo),
                valor: toNumber(a.total)
              }));
            } else {
              const grupo = trim(r.grupoAprov);
              if (grupo && aprovadoresPorGrupo.has(grupo)) {
                const g = aprovadoresPorGrupo.get(grupo);
                origemAprovacao = { tipo: 'GRUPO_POTENCIAL', numero: grupo, descricao: g.descrGrupo };
                aprovacoes = g.aprovadores.map(s => ({
                  nivel: trim(s.nivel),
                  aprovadorCod: trim(s.usuario),
                  aprovadorNome: nomesUsr.get(trim(s.usuario)) || '',
                  liberadoPorCod: '',
                  liberadoPorNome: '',
                  dataLib: '',
                  status: { codigo: 'POTENCIAL', label: 'Potencial', cor: '#5b9bd5' },
                  grupo: trim(s.grupo),
                  valor: 0
                }));
              }
            }
          }
          const liberadas = aprovacoes.filter(a => a.status.codigo === 'LIBERADO');
          const pendentes = aprovacoes.filter(a => a.status.codigo === 'PENDENTE');
          const ultimaLib = liberadas.sort((a, b) => (b.dataLib || '').localeCompare(a.dataLib || ''))[0] || null;
          return {
            filial: r.filial,
            numero: r.numero,
            item: r.item,
            produto: r.produto,
            descricao: r.descricao,
            unidade: r.unidade,
            quantidade: toNumber(r.quantidade),
            atendido: toNumber(r.atendido),
            saldo: Math.max(0, toNumber(r.quantidade) - toNumber(r.atendido)),
            preco: toNumber(r.preco),
            total: toNumber(r.total),
            armazem: r.armazem,
            emissao: trim(r.emissao),
            dataPrevista: trim(r.dataPrevista),
            dias: toNumber(r.dias),
            fornecedor: r.fornecedor,
            fornecedorLoja: r.fornecedorLoja,
            fornecedorNome: r.fornecedorNome,
            origemSC: r.origemSC,
            origemSCItem: r.origemSCItem,
            centroCusto: r.centroCusto,
            usuario: r.usuario,
            usuarioNome: nomesUsr.get(trim(r.usuario)) || '',
            condPag: r.condPag,
            observacao: r.observacao,
            status: st,
            aprovacoes,
            qtdAprovacoes: aprovacoes.length,
            qtdLiberadas: liberadas.length,
            qtdPendentes: pendentes.length,
            ultimaAprovacao: ultimaLib,
            origemAprovacao
          };
        })
        .filter((r) => !statusList || statusList.includes(r.status.codigo));

      return res.json({
        periodo: { inicio: dtInicio, fim: dtFim },
        totalRegistros: dados.length,
        geradoEm: new Date().toISOString(),
        dados
      });
    } catch (error) {
      console.error('Erro em compras/pedidos:', error);
      return res.status(500).json({ message: 'Erro ao listar pedidos de compra.' });
    }
  }
});
