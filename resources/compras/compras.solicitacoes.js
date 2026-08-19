const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);

// Status do SCR010 (alçada de aprovação).
// ⚠️ Corrigido 19/08/2026: o de-para estava INVERTIDO (02 aparecia como "Liberado").
// Confirmado nos dados de produção: '02' = 26 linhas com ZERO liberação (PENDENTE);
// '03' = 847 linhas 100% com CR_DATALIB (LIBERADO); '05/06/07' = histórico já
// resolvido (todas com data). A inversão fazia a SC pendente da Camila (CR_STATUS='02')
// exibir "Liberado" ao lado de "Bloqueada" — contradição que confundiu o usuário.
const decodeStatusAprovacao = (s) => {
  switch (trim(s)) {
    case '02': return { codigo: 'PENDENTE',  label: 'Pendente',  cor: '#f5a500' };
    case '03': return { codigo: 'LIBERADO',  label: 'Liberado',  cor: '#09A013' };
    case '05': return { codigo: 'LIBERADO',  label: 'Liberado',  cor: '#09A013' };
    case '06': return { codigo: 'REJEITADO', label: 'Rejeitado', cor: '#c9302c' };
    case '07': return { codigo: 'REJEITADO', label: 'Rejeitado', cor: '#c9302c' };
    default:   return { codigo: trim(s),     label: trim(s),     cor: '#6b7a90' };
  }
};

const calcStatusSC1 = (r) => {
  const quant = toNumber(r.C1_QUANT);
  const quje = toNumber(r.C1_QUJE);
  const aprov = trim(r.C1_APROV);
  const cotacao = trim(r.C1_COTACAO);
  const pedido = trim(r.C1_PEDIDO);
  const residuo = trim(r.C1_RESIDUO);

  if (residuo === 'S') return { codigo: 'RESIDUO', label: 'Resíduo eliminado', cor: '#6b7a90' };
  if (aprov === 'B') return { codigo: 'BLOQUEADA', label: 'Bloqueada', cor: '#c9302c' };
  if (quant > 0 && quje >= quant) return { codigo: 'ATENDIDA_TOTAL', label: 'Atendida total', cor: '#09A013' };
  if (quje > 0) return { codigo: 'ATENDIDA_PARCIAL', label: 'Atendida parcial', cor: '#800080' };
  if (pedido) return { codigo: 'EM_PEDIDO', label: 'Em pedido', cor: '#1e5fb5' };
  if (cotacao) return { codigo: 'EM_COTACAO', label: 'Em cotação', cor: '#f5a500' };
  if (aprov && aprov !== 'L') return { codigo: 'EM_APROVACAO', label: 'Em aprovação', cor: '#e55a1a' };
  return { codigo: 'EM_ABERTO', label: 'Em aberto', cor: '#5b9bd5' };
};

module.exports = (app) => ({
  verb: 'get',
  route: '/solicitacoes',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { inicio, fim, status, solicitante } = req.query;

    const dtInicio = toProtheusDate(inicio);
    const dtFim = toProtheusDate(fim);

    if (!dtInicio || !dtFim) {
      return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });
    }

    const params = { inicio: dtInicio, fim: dtFim };
    let condSolic = '';
    if (solicitante) {
      params.solicitante = String(solicitante);
      condSolic = `AND RTRIM(sc1.C1_SOLICIT) LIKE '%' + @solicitante + '%'`;
    }

    const sql = `
      SELECT
        RTRIM(sc1.C1_FILIAL)  AS filial,
        RTRIM(sc1.C1_NUM)     AS numero,
        RTRIM(sc1.C1_ITEM)    AS item,
        RTRIM(sc1.C1_PRODUTO) AS produto,
        RTRIM(sc1.C1_DESCRI)  AS descricao,
        RTRIM(sc1.C1_UM)      AS unidade,
        sc1.C1_QUANT          AS quantidade,
        sc1.C1_QUJE           AS atendido,
        sc1.C1_PRECO          AS preco,
        sc1.C1_TOTAL          AS total,
        RTRIM(sc1.C1_LOCAL)   AS armazem,
        sc1.C1_EMISSAO        AS emissao,
        sc1.C1_DATPRF         AS dataPrevista,
        DATEDIFF(day, GETDATE(), sc1.C1_DATPRF) AS dias,
        RTRIM(sc1.C1_SOLICIT) AS solicitante,
        RTRIM(sc1.C1_USER)    AS usuario,
        RTRIM(sc1.C1_CC)      AS centroCusto,
        RTRIM(sc1.C1_FORNECE) AS fornecedor,
        RTRIM(sc1.C1_LOJA)    AS fornecedorLoja,
        RTRIM(sa2.A2_NOME)    AS fornecedorNome,
        RTRIM(sc1.C1_COTACAO) AS cotacao,
        RTRIM(sc1.C1_PEDIDO)  AS pedido,
        RTRIM(sc1.C1_APROV)   AS aprov,
        RTRIM(sc1.C1_RESIDUO) AS residuo,
        RTRIM(sc1.C1_OBS)     AS observacao
      FROM SC1010 sc1 WITH (NOLOCK)
      LEFT JOIN SA2010 sa2 WITH (NOLOCK)
        ON sa2.A2_COD  = sc1.C1_FORNECE
       AND sa2.A2_LOJA = sc1.C1_LOJA
       AND sa2.D_E_L_E_T_ <> '*'
      WHERE sc1.D_E_L_E_T_ <> '*'
        AND sc1.C1_FILIAL = '01'
        AND sc1.C1_EMISSAO BETWEEN @inicio AND @fim
        ${condSolic}
      ORDER BY sc1.C1_EMISSAO DESC, sc1.C1_NUM DESC, sc1.C1_ITEM
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);

      // Busca aprovações em SCR010 (CR_TIPO='SC') para os números retornados
      // e mapeia código de aprovador -> nome via SYS_USR. Usa batches de 500
      // para não estourar limite de parâmetros.
      const numeros = [...new Set(rows.map(r => trim(r.numero)).filter(Boolean))];
      const aprovacoesPorNum = new Map();   // numero -> [linhas]
      const usuariosCods = new Set();
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
                AND CR_TIPO = 'SC'
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
        } catch (e) { console.warn('SC aprovacoes batch err:', e.message); }
      }

      // Busca nomes dos usuários
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
        } catch (e) { console.warn('SC nomes usuarios err:', e.message); }
      }

      const statusList = status ? String(status).split(',').map(s => s.trim()).filter(Boolean) : null;

      const dados = rows
        .map((r) => {
          const st = calcStatusSC1({
            C1_QUANT: r.quantidade,
            C1_QUJE: r.atendido,
            C1_APROV: r.aprov,
            C1_COTACAO: r.cotacao,
            C1_PEDIDO: r.pedido,
            C1_RESIDUO: r.residuo
          });
          const aprovacoes = (aprovacoesPorNum.get(trim(r.numero)) || []).map(a => {
            const apvCod  = trim(a.aprovador);
            const libCod  = trim(a.liberadoPor);
            return {
              nivel: trim(a.nivel),
              aprovadorCod: apvCod,
              aprovadorNome: nomesUsr.get(apvCod) || '',
              liberadoPorCod: libCod,
              liberadoPorNome: nomesUsr.get(libCod) || '',
              dataLib: trim(a.dataLib),
              status: decodeStatusAprovacao(a.status),
              grupo: trim(a.grupo),
              valor: toNumber(a.total)
            };
          });
          // resumo: ultima liberacao + se ainda tem nivel pendente
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
            solicitante: r.solicitante,
            usuario: r.usuario,
            centroCusto: r.centroCusto,
            fornecedor: r.fornecedor,
            fornecedorLoja: r.fornecedorLoja,
            fornecedorNome: r.fornecedorNome,
            cotacao: r.cotacao,
            pedido: r.pedido,
            observacao: r.observacao,
            status: st,
            aprovacoes,
            qtdAprovacoes: aprovacoes.length,
            qtdLiberadas: liberadas.length,
            qtdPendentes: pendentes.length,
            ultimaAprovacao: ultimaLib
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
      console.error('Erro em compras/solicitacoes:', error);
      return res.status(500).json({ message: 'Erro ao listar solicitações de compra.' });
    }
  }
});
