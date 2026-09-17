// PUT /sac/kanban-config — grava SLA por etapa e parâmetros do Kanban de Pós-Venda.
// Body: { sla: [{ etapa, slaHoras }], curvaAValor?, periodoPadraoDias?, amareloPct? }
// Perm 6005 (configurar). Auditado com o antes e o depois.

const Kanban = require('../../services/kanbanPedidos');
const Auditoria = require('../../services/auditoria');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6005]);

const ETAPAS_COM_SLA = new Set(Kanban.ETAPAS.map(e => e.codigo).filter(c => c !== 'entregue'));

module.exports = (app) => ({
  verb: 'put',
  route: '/kanban-config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    // Validação completa ANTES de gravar qualquer coisa.
    const slas = Array.isArray(b.sla) ? b.sla : [];
    for (const s of slas) {
      if (!ETAPAS_COM_SLA.has(String(s.etapa))) {
        return res.status(400).json({ message: `Etapa desconhecida: ${s.etapa}.` });
      }
      const h = Number(s.slaHoras);
      if (!Number.isFinite(h) || h <= 0 || h > 8760) {
        return res.status(400).json({ message: `O SLA de "${s.etapa}" precisa ser um número de horas entre 0 e 8760.` });
      }
    }
    const params = [];
    if (b.curvaAValor != null) {
      const v = Number(b.curvaAValor);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ message: 'O valor da Curva A precisa ser maior que zero.' });
      params.push(['curva_a_valor', String(v)]);
    }
    if (b.periodoPadraoDias != null) {
      const v = Number(b.periodoPadraoDias);
      if (!Number.isInteger(v) || v < 7 || v > 730) return res.status(400).json({ message: 'O período padrão precisa ser de 7 a 730 dias.' });
      params.push(['periodo_padrao_dias', String(v)]);
    }
    if (b.amareloPct != null) {
      const v = Number(b.amareloPct);
      if (!Number.isFinite(v) || v < 10 || v > 99) return res.status(400).json({ message: 'O amarelo precisa começar entre 10% e 99% do SLA.' });
      params.push(['amarelo_pct', String(v)]);
    }

    try {
      const antes = await Kanban.carregarConfig(app);
      for (const s of slas) {
        await Pg.connectAndQuery(
          `UPDATE tab_kanban_pedido_sla SET sla_horas = @h, atualizado_em = NOW(), atualizado_por = @u WHERE etapa = @e`,
          { h: Number(s.slaHoras), u: user ? user.ID : null, e: String(s.etapa) });
      }
      for (const [chave, valor] of params) {
        await Pg.connectAndQuery(
          `UPDATE tab_kanban_pedido_config SET valor = @v, atualizado_em = NOW(), atualizado_por = @u WHERE chave = @c`,
          { v: valor, u: user ? user.ID : null, c: chave });
      }
      const depois = await Kanban.carregarConfig(app);
      // Os cards em cache foram montados com o SLA antigo.
      Kanban.limparCache();

      Auditoria.registrar(app, {
        modulo: 'SAC', submodulo: 'KanbanPedidos', acao: 'CONFIG', severidade: 'INFO', req,
        entidade: 'kanban_config', entidadeId: 'sla',
        descricao: 'Alterou SLA/parâmetros do Kanban de Pedidos',
        antes: { sla: antes.sla, curvaAValor: antes.curvaAValor, periodoPadraoDias: antes.periodoPadraoDias, amareloPct: antes.amareloPct },
        depois: { sla: depois.sla, curvaAValor: depois.curvaAValor, periodoPadraoDias: depois.periodoPadraoDias, amareloPct: depois.amareloPct }
      });

      return res.json({
        sla: depois.slaLista, curvaAValor: depois.curvaAValor,
        periodoPadraoDias: depois.periodoPadraoDias, amareloPct: depois.amareloPct
      });
    } catch (err) {
      console.error('Erro sac/kanban-config PUT:', err);
      return res.status(500).json({ message: 'Não foi possível salvar a configuração do Kanban.' });
    }
  }
});
