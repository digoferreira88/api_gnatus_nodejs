// GET /contratos/dashboard — KPIs e graficos do painel inicial
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5002]);
const Contratos = require('../../services/contratos');

module.exports = (app) => ({
  verb: 'get',
  route: '/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT id, tipo, vigencia_inicio, vigencia_fim, valor_total, valor_mensal,
               encerrado, contraparte_nome, contraparte_cod, contraparte_loja
          FROM tab_contrato`, {});

      const enriquecidos = rows.map(Contratos.enriquecer);
      const byStatus = {};
      const byTipo = {};
      const porContraparte = {};
      let valorMensalTotal = 0;
      let valorTotal = 0;
      let proximosVencimentos = [];

      for (const c of enriquecidos) {
        byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        byTipo[c.tipo] = byTipo[c.tipo] || { qt: 0, mensal: 0 };
        byTipo[c.tipo].qt += 1;
        byTipo[c.tipo].mensal += Number(c.valor_mensal || 0);

        if (c.status === 'VIGENTE' || c.status === 'VENCENDO') {
          valorMensalTotal += Number(c.valor_mensal || 0);
        }
        valorTotal += Number(c.valor_total || 0);

        const chaveCp = `${c.contraparte_cod || ''}|${c.contraparte_loja || ''}|${c.contraparte_nome}`;
        if (!porContraparte[chaveCp]) {
          porContraparte[chaveCp] = { nome: c.contraparte_nome, qt: 0, mensal: 0 };
        }
        porContraparte[chaveCp].qt += 1;
        porContraparte[chaveCp].mensal += Number(c.valor_mensal || 0);

        if (c.dias_para_vencimento != null && c.dias_para_vencimento >= 0 && c.dias_para_vencimento <= 90) {
          proximosVencimentos.push({
            id: c.id, titulo: c.titulo || `Contrato #${c.id}`,
            contraparte: c.contraparte_nome, dias: c.dias_para_vencimento,
            vigencia_fim: c.vigencia_fim, valor_mensal: c.valor_mensal
          });
        }
      }

      // Top contraparte por valor mensal
      const topContraparte = Object.values(porContraparte)
        .sort((a, b) => b.mensal - a.mensal)
        .slice(0, 10);

      // Por tipo (pra grafico pizza/barra)
      const porTipoArr = Object.entries(byTipo).map(([tipo, v]) => ({
        tipo, label: Contratos.TIPOS_LABEL[tipo] || tipo, qt: v.qt, valorMensal: Number(v.mensal.toFixed(2))
      })).sort((a, b) => b.qt - a.qt);

      proximosVencimentos.sort((a, b) => a.dias - b.dias);

      return res.json({
        kpis: {
          total: enriquecidos.length,
          vigentes: byStatus.VIGENTE || 0,
          vencendo: byStatus.VENCENDO || 0,
          vencidos: byStatus.VENCIDO || 0,
          rascunho: byStatus.RASCUNHO || 0,
          encerrados: byStatus.ENCERRADO || 0,
          valor_mensal_total: Number(valorMensalTotal.toFixed(2)),
          valor_total_carteira: Number(valorTotal.toFixed(2))
        },
        por_status: byStatus,
        por_tipo: porTipoArr,
        top_contraparte: topContraparte,
        proximos_vencimentos: proximosVencimentos.slice(0, 20)
      });
    } catch (err) {
      console.error('contratos/dashboard:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
