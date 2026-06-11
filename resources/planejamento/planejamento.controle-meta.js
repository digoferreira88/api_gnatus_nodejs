// POST /planejamento/controle/meta  { mes:'YYYYMM', metaMensal, diasUteis }
// Define a meta do mês (TB BASE). Permissão 3003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3003]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/controle/meta',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const mes = trim(b.mes);
    if (!/^\d{6}$/.test(mes)) return res.status(400).json({ message: 'mes (YYYYMM) inválido.' });
    const metaMensal = N(b.metaMensal);
    const diasUteis = Math.max(1, N(b.diasUteis) || 21);

    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_plan_meta (mes, meta_mensal, dias_uteis, atualizado_por)
        VALUES (@mes, @meta, @dias, @uid)
        ON CONFLICT (mes) DO UPDATE SET meta_mensal=@meta, dias_uteis=@dias, atualizado_em=NOW(), atualizado_por=@uid`,
        { mes, meta: metaMensal, dias: diasUteis, uid: user?.ID || null });

      Auditoria.registrar(app, {
        modulo: 'Planejamento', submodulo: 'ControleFaturamento', acao: 'DEFINIR_META', severidade: 'INFO', req,
        entidade: 'meta', entidadeId: mes, descricao: `Definiu meta ${mes}: R$ ${metaMensal.toLocaleString('pt-BR')} em ${diasUteis} dias úteis`,
        meta: { mes, metaMensal, diasUteis }
      });
      return res.json({ ok: true, mes, metaMensal, diasUteis });
    } catch (err) {
      console.error('Erro controle-meta:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
