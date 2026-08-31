// GET /dashboard/resumo — números do Dashboard, montados conforme a PERMISSÃO
// de quem pede. Quem não tem a permissão do módulo simplesmente não recebe o
// bloco (a tela não mostra o card), em vez de receber zero — zero mentiria.
//
// Regras de projeto desta rota:
//
//  1) LEVE. É a primeira coisa que carrega depois do login, para todo mundo.
//     Só COUNT e SUM agregado; nada de listar linha a linha nem enriquecer.
//
//  2) CADA BLOCO É ISOLADO. Um try/catch por bloco: se o Protheus engasgar numa
//     consulta, os outros cards continuam aparecendo. A rota nunca devolve 500
//     por causa de um bloco — devolve o que conseguiu e marca o que falhou.
//
//  3) NÃO DUPLICA REGRA COMPLEXA. Aprovações pendentes tem alçada, multi-grupo
//     e o filtro de pendência fantasma; cobrança tem a régua de promessas. Esses
//     dois NÃO são recalculados aqui — o front consome os endpoints próprios
//     (/aprovacoes/pendentes e /cobranca/acoes-resumo), que são a fonte da
//     verdade. Aqui ficam só os agregados simples.
//
// Permissões por bloco: liberação 8006/8007 · expedição 12001 · faturamento
// 10001 (e SÓ 10001 — ver a nota no bloco). Admin (perm 0) vê todos.

const FILIAL = '01';

// Mesmos CFOPs de venda usados no Dashboard de Receita (gerencia.dashboard-receita).
// Se mudarem lá, mudam aqui — estão duplicados de propósito para esta rota não
// depender do carregamento daquele módulo.
const CFOPS_VENDA = ['5105', '5106', '5116', '5117', '5119', '5405', '5933',
  '6105', '6106', '6107', '6108', '6109', '6110', '6116', '6117',
  '6119', '6122', '6123', '6404', '6933', '5907', '6907', '5924'];

const inClause = (lista, prefixo) => {
  const nomes = lista.map((_, i) => `@${prefixo}${i}`);
  const params = {};
  lista.forEach((v, i) => { params[`${prefixo}${i}`] = v; });
  return { sql: nomes.join(','), params };
};

// YYYYMM de N meses atrás (inclusive o atual)
const ymDesde = (meses) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (meses - 1));
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const ymAtual = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/resumo',
  middlewares: [],   // exige login (authentication global); a permissão é por bloco

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    // --- Permissões do usuário -------------------------------------------
    let perms = [];
    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id_permissao FROM tab_intranet_usr_permissoes WHERE id_user = @id`,
        { id: user.ID });
      perms = (rows || []).map(r => Number(r.id_permissao));
    } catch (err) {
      console.error('dashboard/resumo — falha ao ler permissões:', err.message);
      return res.status(500).json({ message: 'Não foi possível carregar suas permissões.' });
    }
    const admin = perms.includes(0);
    const pode = (...lista) => admin || lista.some(p => perms.includes(p));

    const out = { blocos: {}, falhas: [] };

    // --- 1) Pedidos aguardando liberação do Financeiro --------------------
    // Espelha financeiro.liberacao-list: estágio 20 da view pedidos_estatus,
    // MAIS o C9_BLCRED='04' que a view não mapeia (também é bloqueio de
    // crédito e cairia em "Desconhecido"). Quando o Diego corrigir a view,
    // o OR sai daqui e de lá ao mesmo tempo.
    if (pode(8006, 8007)) {
      try {
        const rows = await Protheus.connectAndQuery(`
          SELECT COUNT(*) AS qtd
            FROM SC5010 sc5 WITH (NOLOCK)
           WHERE sc5.C5_FILIAL = @filial
             AND sc5.D_E_L_E_T_ <> '*'
             AND RTRIM(ISNULL(sc5.C5_NOTA, '')) = ''
             AND EXISTS (
                   SELECT 1 FROM pedidos_estatus pe
                    WHERE pe.c6_filial = sc5.C5_FILIAL
                      AND pe.c6_num    = sc5.C5_NUM
                      AND (pe.estatus_cod = 20
                           OR RTRIM(ISNULL(pe.c9_blcred, '')) = '04'))`,
          { filial: FILIAL });
        out.blocos.liberacao = { qtd: Number(rows?.[0]?.qtd || 0) };
      } catch (err) {
        console.error('dashboard/resumo — liberação:', err.message);
        out.falhas.push('liberacao');
      }
    }

    // --- 2) Notas fiscais a expedir ---------------------------------------
    // Espelha expedicao.notas (aba "pendentes"): NF sem registro de expedição.
    // A janela é a MESMA que a tela abre por padrão (dia 1º do mês anterior),
    // senão o card mostraria um número que a tela nunca confirma.
    // 12001 é a permissão da tela de Notas a Expedir, que é para onde o card leva.
    if (pode(12001)) {
      try {
        const rows = await Protheus.connectAndQuery(`
          SELECT COUNT(*) AS qtd
            FROM SF2010 f2 WITH (NOLOCK)
            LEFT JOIN faturamento_expedicao fe
              ON fe.z1_filial = f2.F2_FILIAL
             AND fe.z1_doc    = f2.F2_DOC
             AND fe.z1_serie  = f2.F2_SERIE
           WHERE f2.D_E_L_E_T_ <> '*'
             AND f2.F2_FILIAL = @filial
             AND fe.z1_expedic IS NULL
             AND f2.F2_EMISSAO >= @desde`,
          { filial: FILIAL, desde: ymDesde(2) + '01' });
        out.blocos.expedicao = { qtd: Number(rows?.[0]?.qtd || 0) };
      } catch (err) {
        console.error('dashboard/resumo — expedição:', err.message);
        out.falhas.push('expedicao');
      }
    }

    // --- 3) Faturamento: série de 12 meses + mês corrente ------------------
    // Mesma base do Dashboard de Receita: SD2 x SF2 pelos CFOPs de venda.
    // ⚠️ Só 10001. A 10003 é o gestor que enxerga apenas o próprio centro de
    // custo — mostrar o faturamento TOTAL da empresa para ele seria vazamento.
    if (pode(10001)) {
      try {
        const inV = inClause(CFOPS_VENDA, 'cv');
        const rows = await Protheus.connectAndQuery(`
          SELECT LEFT(sd2.D2_EMISSAO, 6) ym, SUM(sd2.D2_TOTAL) receita
            FROM SD2010 sd2 WITH (NOLOCK)
            INNER JOIN SF2010 sf2 WITH (NOLOCK)
               ON sf2.F2_FILIAL = sd2.D2_FILIAL AND sf2.F2_DOC = sd2.D2_DOC
              AND sf2.F2_SERIE = sd2.D2_SERIE AND sf2.F2_CLIENTE = sd2.D2_CLIENTE
              AND sf2.F2_LOJA = sd2.D2_LOJA AND sf2.D_E_L_E_T_ <> '*'
           WHERE sd2.D_E_L_E_T_ <> '*'
             AND sd2.D2_FILIAL = @filial
             AND sd2.D2_EMISSAO >= @desde
             AND RTRIM(sd2.D2_CF) IN (${inV.sql})
           GROUP BY LEFT(sd2.D2_EMISSAO, 6)
           ORDER BY ym`,
          { filial: FILIAL, desde: ymDesde(12) + '01', ...inV.params });

        const serie = (rows || []).map(r => ({
          ym: String(r.ym),
          valor: Number(r.receita || 0)
        }));
        const atual = serie.find(s => s.ym === ymAtual());

        // Comparativo do mês corrente com o MESMO PERÍODO do mês anterior
        // (dia 1 até hoje), não com o mês anterior fechado. Comparar um mês em
        // curso com um mês inteiro mostraria uma queda enorme e falsa em todo
        // dia que não fosse o último do mês.
        const hoje = new Date();
        const dia = String(hoje.getDate()).padStart(2, '0');
        const ant = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
        const ymAnt = `${ant.getFullYear()}${String(ant.getMonth() + 1).padStart(2, '0')}`;

        const rowsAnt = await Protheus.connectAndQuery(`
          SELECT SUM(sd2.D2_TOTAL) receita
            FROM SD2010 sd2 WITH (NOLOCK)
            INNER JOIN SF2010 sf2 WITH (NOLOCK)
               ON sf2.F2_FILIAL = sd2.D2_FILIAL AND sf2.F2_DOC = sd2.D2_DOC
              AND sf2.F2_SERIE = sd2.D2_SERIE AND sf2.F2_CLIENTE = sd2.D2_CLIENTE
              AND sf2.F2_LOJA = sd2.D2_LOJA AND sf2.D_E_L_E_T_ <> '*'
           WHERE sd2.D_E_L_E_T_ <> '*'
             AND sd2.D2_FILIAL = @filial
             AND sd2.D2_EMISSAO BETWEEN @ini AND @fim
             AND RTRIM(sd2.D2_CF) IN (${inV.sql})`,
          { filial: FILIAL, ini: `${ymAnt}01`, fim: `${ymAnt}${dia}`, ...inV.params });

        const base = Number(rowsAnt?.[0]?.receita || 0);
        const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
        const mesFechado = hoje.getDate() === ultimoDia;

        out.blocos.faturamento = {
          serie,
          mesAtual: atual ? atual.valor : 0,
          baseComparacao: base,
          ymComparacao: ymAnt,
          diaCorte: Number(dia),
          mesFechado,
          variacao: base > 0 && atual ? ((atual.valor - base) / base) * 100 : null
        };
      } catch (err) {
        console.error('dashboard/resumo — faturamento:', err.message);
        out.falhas.push('faturamento');
      }
    }

    return res.json(out);
  }
});
