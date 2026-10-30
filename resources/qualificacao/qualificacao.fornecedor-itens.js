// GET /qualificacao/fornecedores/:id/itens-fornecidos?meses=24 — itens que o fornecedor
// entregou (NFs de entrada, SD1) cruzados com a lista de itens críticos: dá à Engenharia
// a criticidade SUGERIDA do fornecedor ("é qualificado pela criticidade do item que fornece").
// Leitura do Protheus. Perm 23001+.

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

module.exports = (app) => ({
  verb: 'get',
  route: '/fornecedores/:id/itens-fornecidos',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const id = Number(req.params.id);
    const meses = Math.min(60, Math.max(1, Number(req.query.meses) || 24));
    try {
      const [f] = await Pg.connectAndQuery(`SELECT id, codigo, criticidades FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      if (!/^\d{6}$/.test(f.codigo)) return res.json({ itens: [], sugeridas: [], aviso: 'Fornecedor com código provisório — sem histórico no Protheus.' });
      const corte = new Date(); corte.setMonth(corte.getMonth() - meses);
      const ymd = corte.toISOString().slice(0, 10).replace(/-/g, '');
      let itens;
      try {
        itens = await Protheus.connectAndQuery(
          `SELECT RTRIM(d1.D1_COD) produto, MAX(RTRIM(COALESCE(b1.B1_DESC, ''))) descricao, MAX(RTRIM(COALESCE(b1.B1_TIPO, ''))) tipo,
                  COUNT(DISTINCT d1.D1_DOC + d1.D1_SERIE) notas, SUM(d1.D1_QUANT) quantidade, MAX(d1.D1_DTDIGIT) ultima
             FROM SD1010 d1 WITH (NOLOCK)
             LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD = d1.D1_COD AND b1.D_E_L_E_T_ <> '*'
            WHERE d1.D_E_L_E_T_ <> '*' AND d1.D1_FILIAL = '01' AND d1.D1_FORNECE = @cod AND d1.D1_DTDIGIT >= @desde AND d1.D1_TIPO = 'N'
            GROUP BY RTRIM(d1.D1_COD)
            ORDER BY MAX(d1.D1_DTDIGIT) DESC`, { cod: f.codigo, desde: ymd });
      } catch (e) {
        if (ehConexao(e)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
        throw e;
      }
      const chaves = itens.map(i => R.chaveItem(i.produto));
      const crit = chaves.length ? await Pg.connectAndQuery(`SELECT produto_chave, criticidade FROM tab_qf_item_critico WHERE ativo AND produto_chave = ANY(@k)`, { k: chaves }) : [];
      const porChave = new Map(crit.map(c => [c.produto_chave, c.criticidade]));
      const linhas = itens.map(i => ({
        produto: i.produto, descricao: i.descricao, tipo: i.tipo, notas: Number(i.notas), quantidade: Number(i.quantidade),
        ultima: i.ultima ? `${i.ultima.slice(0, 4)}-${i.ultima.slice(4, 6)}-${i.ultima.slice(6, 8)}` : null,
        criticidade: porChave.get(R.chaveItem(i.produto)) || null
      }));
      const sugeridas = R.normCriticidades([...new Set(linhas.map(l => l.criticidade).filter(Boolean))]);
      const atuais = R.normCriticidades(f.criticidades);
      return res.json({
        meses, itens: linhas, sugeridas,
        faltando: sugeridas.filter(c => !atuais.includes(c)),       // fornece item crítico sem estar qualificado nessa criticidade
        semItem: atuais.filter(c => !sugeridas.includes(c))         // qualificado numa criticidade que não aparece no período
      });
    } catch (err) { return Q.falha(res, 'listar os itens fornecidos', err); }
  }
});
