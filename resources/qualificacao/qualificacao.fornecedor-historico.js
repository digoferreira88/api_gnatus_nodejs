// GET /qualificacao/fornecedores/:id/historico — todas as inspeções do fornecedor,
// série mensal do IQF (média do mês e média acumulada) e linha do tempo de NCs/RNCs.
// Reaprovado após reprovação (`iqf_desde`): a média acumulada recomeça nessa data, como a oficial.
// Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/fornecedores/:id/historico',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    try {
      const [f] = await Pg.connectAndQuery(`SELECT id, codigo, razao_social, iqf_medio, qtd_inspecoes, classificacao, iqf_desde FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const inspecoes = await Pg.connectAndQuery(
        `SELECT id, rel_insp, data_inspecao, pedido_compras, cod_item, nota_fiscal, lote, nivel_inspecao, qtd_recebida, qtd_inspecionada,
                qtd_aprovada, qtd_reprovada, rnc_numero, dias_atraso, indice_c, indice_p, indice_n, iqf, nc, c_manual, p_manual, n_manual,
                responsavel_nome, origem, legado_avisos, item_criticidade, tipo_prazo, (bloqueio_justificativa IS NOT NULL) AS liberado_pela_qualidade
           FROM tab_qf_inspecao WHERE fornecedor_id = @id AND NOT excluido
          ORDER BY data_inspecao NULLS FIRST, rel_insp`, { id });

      // série mensal (só datas plausíveis — as digitadas no futuro ficam fora do gráfico)
      const hoje = new Date().toISOString().slice(0, 10);
      const porMes = new Map();
      const desde = f.iqf_desde ? (f.iqf_desde instanceof Date ? f.iqf_desde.toISOString() : String(f.iqf_desde)).slice(0, 10) : null;
      let soma = 0, qtd = 0, reiniciou = false;
      for (const i of inspecoes) {
        if (!i.data_inspecao || i.iqf == null) continue;
        const d = new Date(i.data_inspecao).toISOString().slice(0, 10);
        if (d > hoje) continue;
        const mes = d.slice(0, 7);
        const m = porMes.get(mes) || { mes, soma: 0, qtd: 0, ncs: 0, somaDesde: 0, qtdDesde: 0 };
        m.soma += Number(i.iqf); m.qtd++; if (i.nc) m.ncs++;
        if (desde && d >= desde) { m.somaDesde += Number(i.iqf); m.qtdDesde++; }
        porMes.set(mes, m);
      }
      const serie = [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)).map(m => {
        if (desde && m.mes >= desde.slice(0, 7)) {
          if (!reiniciou) { soma = 0; qtd = 0; reiniciou = true; }
          soma += m.somaDesde; qtd += m.qtdDesde;
        } else { soma += m.soma; qtd += m.qtd; }
        return { mes: m.mes, iqfMes: Q.r4(m.soma / m.qtd), qtd: m.qtd, ncs: m.ncs, iqfAcumulado: qtd ? Q.r4(soma / qtd) : null };
      });
      const ncs = inspecoes.filter(i => i.nc).map(i => ({
        id: i.id, rel_insp: i.rel_insp, data: i.data_inspecao, cod_item: i.cod_item, rnc: i.rnc_numero,
        qtd_reprovada: i.qtd_reprovada, qtd_inspecionada: i.qtd_inspecionada
      }));
      return res.json({ fornecedor: f, inspecoes: inspecoes.reverse(), serie, ncs });
    } catch (err) { return Q.falha(res, 'carregar o histórico', err); }
  }
});
