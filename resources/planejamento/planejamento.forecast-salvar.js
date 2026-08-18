// POST /planejamento/forecast/salvar
// Body: { carteira, ano, itens: [{ produto, mes, qtd }] }  (só as células alteradas)
// Salva a PREVISÃO. Vendedor só na carteira dele; gestão em qualquer. Respeita
// config.aberto. Perm 18001/18002.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([18001, 18002, 0]);
const Acesso = require('../../services/forecastAcesso');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/forecast/salvar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const b = req.body || {};
    const carteiraId = Number(b.carteira);
    const ano = Number(b.ano);
    const itensRaw = Array.isArray(b.itens) ? b.itens : [];
    if (!Number.isInteger(carteiraId) || carteiraId <= 0) return res.status(400).json({ message: 'carteira inválida.' });
    if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) return res.status(400).json({ message: 'ano inválido.' });

    // sanitiza células
    const itens = [];
    for (const it of itensRaw) {
      const produto = String(it.produto || '').trim();
      const mes = Number(it.mes);
      const qtd = Math.round(Number(it.qtd));
      if (!produto || !(mes >= 1 && mes <= 12) || !Number.isFinite(qtd) || qtd < 0) continue;
      itens.push({ produto, mes, qtd: Math.min(qtd, 9999999) });
    }
    if (!itens.length) return res.status(400).json({ message: 'Nenhuma célula válida para salvar.' });
    if (itens.length > 5000) return res.status(400).json({ message: 'Muitas células de uma vez (máx. 5000).' });

    try {
      const gestao = await Acesso.ehGestao(Pg, user.ID);
      const { cart, pode } = await Acesso.carteiraSePode(Pg, user.ID, gestao, carteiraId);
      if (!cart) return res.status(404).json({ message: 'Carteira não encontrada.' });
      if (!pode) return res.status(403).json({ message: 'Sem acesso a esta carteira.' });

      const cfg = (await Pg.connectAndQuery(`SELECT aberto FROM tab_forecast_config WHERE ano=@a`, { a: ano }))[0];
      if (cfg && !cfg.aberto) return res.status(409).json({ message: `Forecast de ${ano} está fechado para edição.` });

      await Pg.withTransaction(async (client) => {
        const CH = 500;
        for (let i = 0; i < itens.length; i += CH) {
          const slice = itens.slice(i, i + CH);
          const vals = []; const params = [];
          slice.forEach(it => {
            const base = params.length;
            vals.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},NOW())`);
            params.push(ano, carteiraId, it.produto, it.mes, it.qtd, user.ID);
          });
          await client.query(
            `INSERT INTO tab_forecast_previsao (ano, carteira_id, produto_cod, mes, qtd, atualizado_por, atualizado_em)
             VALUES ${vals.join(',')}
             ON CONFLICT (ano, carteira_id, produto_cod, mes)
             DO UPDATE SET qtd = EXCLUDED.qtd, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
            params);
        }
      });

      Auditoria.registrar(app, {
        modulo: 'Planejamento', submodulo: 'Forecast', acao: 'SALVAR_PREVISAO', severidade: 'INFO', req,
        entidade: 'forecast_carteira', entidadeId: String(carteiraId),
        descricao: `Salvou ${itens.length} célula(s) de previsão — carteira "${cart.nome}" (${ano})`,
        meta: { carteira: carteiraId, ano, celulas: itens.length }
      });

      return res.json({ ok: true, salvas: itens.length });
    } catch (err) {
      console.error('forecast/salvar:', err);
      return res.status(500).json({ message: 'Erro ao salvar a previsão.' });
    }
  }
});
