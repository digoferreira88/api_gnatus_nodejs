// PUT /compras/cockpit-meta — meta anual de faturamento do Cockpit S&OP.
// Body: { ano, meta }.  Era uma constante dentro do HTML (META_FAT26); agora fica em
// tab_sop_meta para virar o ano sem deploy. Permissão 4008, com auditoria.

const Cockpit = require('../../services/cockpitSopMontar');
const Auditoria = require('../../services/auditoria');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4008]);

module.exports = (app) => ({
  verb: 'put',
  route: '/cockpit-meta',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const ano = Number((req.body || {}).ano);
    const meta = Number((req.body || {}).meta);

    const anoAtual = new Date().getFullYear();
    if (!Number.isInteger(ano) || ano < anoAtual - 5 || ano > anoAtual + 5) {
      return res.status(400).json({ message: `O ano precisa estar entre ${anoAtual - 5} e ${anoAtual + 5}.` });
    }
    if (!Number.isFinite(meta) || meta <= 0) {
      return res.status(400).json({ message: 'A meta precisa ser um valor maior que zero.' });
    }

    try {
      const antes = await Pg.connectAndQuery(`SELECT meta_faturamento::float meta FROM tab_sop_meta WHERE ano = @ano`, { ano });
      await Pg.connectAndQuery(`
        INSERT INTO tab_sop_meta (ano, meta_faturamento, atualizado_em, atualizado_por)
        VALUES (@ano, @meta, NOW(), @u)
        ON CONFLICT (ano) DO UPDATE SET meta_faturamento = EXCLUDED.meta_faturamento,
                                        atualizado_em = NOW(), atualizado_por = EXCLUDED.atualizado_por`,
        { ano, meta, u: user ? user.ID : null });
      Cockpit.limparCache();   // o painel guarda a meta junto com o resto do D

      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'CockpitSOP', acao: 'META', severidade: 'INFO', req,
        entidade: 'sop_meta', entidadeId: String(ano),
        descricao: `Meta de faturamento de ${ano} definida em R$ ${meta.toLocaleString('pt-BR')}`,
        antes: antes.length ? { meta: antes[0].meta } : null, depois: { meta }
      });

      return res.json({ ano, meta });
    } catch (err) {
      console.error('Erro compras/cockpit-meta:', err);
      return res.status(500).json({ message: 'Não foi possível salvar a meta.' });
    }
  }
});
