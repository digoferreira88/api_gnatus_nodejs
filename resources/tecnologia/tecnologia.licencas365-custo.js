// POST /tecnologia/licencas365/custo — cadastra o valor mensal de um SKU M365.
// Body: { partNumber, valorMensal, obs }. valorMensal null/vazio = remove o
// cadastro (SKU volta a aparecer sem custo). Perm 1035. Auditado.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1035]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/licencas365/custo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const partNumber = trim(req.body?.partNumber).slice(0, 80);
    const obs = trim(req.body?.obs).slice(0, 200) || null;
    const bruto = req.body?.valorMensal;
    if (!partNumber) return res.status(400).json({ message: 'partNumber é obrigatório.' });

    const remover = bruto == null || trim(bruto) === '';
    const valorMensal = remover ? null : Number(String(bruto).replace(',', '.'));
    if (!remover && (!Number.isFinite(valorMensal) || valorMensal < 0)) {
      return res.status(400).json({ message: 'valorMensal inválido.' });
    }
    const por = trim(user?.NOME) || null;

    try {
      if (remover) {
        await Pg.connectAndQuery(
          `DELETE FROM tab_m365_licenca_custo WHERE sku_part_number = @sku`, { sku: partNumber });
        Auditoria.registrar(app, {
          modulo: 'Tecnologia', submodulo: 'Licencas365', acao: 'CUSTO_REMOVER', severidade: 'INFO', req,
          entidade: 'm365_licenca_custo', entidadeId: partNumber,
          descricao: `Removeu o valor mensal da licença ${partNumber}`
        });
        return res.json({ ok: true, removido: true });
      }

      await Pg.connectAndQuery(`
        INSERT INTO tab_m365_licenca_custo (sku_part_number, valor_mensal, obs, atualizado_por, atualizado_em)
        VALUES (@sku, @valor, @obs, @por, NOW())
        ON CONFLICT (sku_part_number)
        DO UPDATE SET valor_mensal = EXCLUDED.valor_mensal, obs = EXCLUDED.obs,
                      atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
        { sku: partNumber, valor: valorMensal, obs, por });

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'Licencas365', acao: 'CUSTO_SALVAR', severidade: 'INFO', req,
        entidade: 'm365_licenca_custo', entidadeId: partNumber,
        descricao: `Licença ${partNumber}: R$ ${valorMensal.toFixed(2)}/mês${obs ? ` (${obs})` : ''}`,
        meta: { partNumber, valorMensal, obs }
      });
      return res.json({ ok: true, valorMensal, por, em: new Date().toISOString() });
    } catch (err) {
      console.error('tecnologia/licencas365-custo:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
