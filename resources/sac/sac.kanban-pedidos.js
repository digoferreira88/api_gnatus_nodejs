// GET /sac/kanban-pedidos — Kanban de Gestão de Pedidos (Pós-Venda / CS), Fase 1.
//
// Query (todos opcionais):
//   ini, fim      emissão do pedido, YYYY-MM-DD (padrão: últimos N dias da config)
//   vendedor      código do vendedor (C5_VEND1)
//   equipe        equipe do de-para BU -> equipe (tab_cobranca_bu_equipe)
//   curvaA=1      só pedidos Curva A
//   estourado=1   só SLA estourado
//   busca         número do pedido ou parte do nome do cliente
//   etapa         devolve TODOS os cards dessa etapa (as demais vêm sem cards)
//   limite        cards por coluna (padrão 40, máx 500)
//
// Leitura pura do Protheus + cache de entregas. Regras em services/kanbanPedidos.js.
// Perm 6004 (ver) ou 6005 (configurar). Admin (0) passa pelo requirePerm.

const Kanban = require('../../services/kanbanPedidos');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6004, 6005]);
const liga = (v) => /^(1|true|sim|on)$/i.test(String(v || ''));

module.exports = (app) => ({
  verb: 'get',
  route: '/kanban-pedidos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const q = req.query || {};
    try {
      const dados = await Kanban.montarKanban(app, {
        ini: q.ini, fim: q.fim, vendedor: q.vendedor, equipe: q.equipe,
        curvaA: liga(q.curvaA), estourado: liga(q.estourado),
        busca: q.busca, etapa: q.etapa, limite: q.limite, exportar: q.exportar
      });
      return res.json(dados);
    } catch (err) {
      console.error('Erro sac/kanban-pedidos:', err);
      return res.status(500).json({ message: 'Não foi possível montar o Kanban de pedidos. Tente de novo em instantes.' });
    }
  }
});
