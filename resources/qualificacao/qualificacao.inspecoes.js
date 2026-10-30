// GET /qualificacao/inspecoes — relatórios de inspeção de recebimento (FORM 7.4.3.H),
// paginados no servidor, com totais do filtro (qtd, % conforme, IQF médio).
// Filtros em _filtroInspecoes.js. Ordem: rel | data | iqf | fornecedor (+ dir). Perm 23001+.

const Q = require('../../services/qfCore');
const filtro = require('./_filtroInspecoes');

const ORDENS = { rel: 'i.rel_insp', data: 'i.data_inspecao', iqf: 'i.iqf', fornecedor: 'i.fornecedor_nome' };

module.exports = (app) => ({
  verb: 'get',
  route: '/inspecoes',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));
    const { where, params } = filtro(req.query);
    const ordem = ORDENS[req.query.ordem] || 'i.rel_insp';
    const dir = Q.trim(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    try {
      const [tot] = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE i.nc)::int ncs, AVG(i.iqf) iqf_medio,
                SUM(i.qtd_inspecionada) inspecionadas, SUM(i.qtd_reprovada) reprovadas
           FROM tab_qf_inspecao i WHERE ${where}`, params);
      const linhas = await Pg.connectAndQuery(
        `SELECT i.id, i.rel_insp, i.fornecedor_id, i.fornecedor_codigo, i.fornecedor_nome, i.pedido_compras, i.cod_item, i.descricao_item,
                i.nota_fiscal, i.lote, i.nivel_inspecao, i.qtd_recebida, i.qtd_inspecionada, i.qtd_aprovada, i.qtd_reprovada,
                i.rnc_numero, i.data_entrega_prevista, i.data_entrega_real, i.data_inspecao, i.dias_atraso,
                i.indice_c, i.indice_p, i.indice_n, i.iqf, i.nc, i.c_manual, i.p_manual, i.n_manual,
                i.responsavel_nome, i.criado_por, i.origem, i.legado_avisos, i.excluido, i.item_criticidade, i.tipo_prazo,
                (i.bloqueio_justificativa IS NOT NULL) AS liberado_pela_qualidade,
                (SELECT COUNT(*)::int FROM tab_qf_anexo a WHERE a.entidade = 'inspecao' AND a.entidade_id = i.id AND NOT a.excluido) AS anexos
           FROM tab_qf_inspecao i
          WHERE ${where}
          ORDER BY ${ordem} ${dir} NULLS LAST, i.rel_insp DESC
          LIMIT @lim OFFSET @off`, { ...params, lim: pageSize, off: (page - 1) * pageSize });
      return res.json({
        total: tot.n, page, pageSize, linhas,
        resumo: {
          inspecoes: tot.n, comNc: tot.ncs, pctConforme: tot.n ? Math.round((1 - tot.ncs / tot.n) * 1000) / 10 : null,
          iqfMedio: tot.iqf_medio != null ? Q.r4(tot.iqf_medio) : null,
          pecasInspecionadas: Number(tot.inspecionadas) || 0, pecasReprovadas: Number(tot.reprovadas) || 0
        }
      });
    } catch (err) { return Q.falha(res, 'listar as inspeções', err); }
  }
});
