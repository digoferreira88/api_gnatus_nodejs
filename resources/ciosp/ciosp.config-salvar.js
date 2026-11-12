// PUT /ciosp/config — configuração da edição: ativa (uma por vez), desconto livre do
// vendedor e validade do orçamento. Ativar uma edição semeia as 4 formas de pagamento
// impressas na Tabela Comercial. Perm 19004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'put',
  route: '/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const edicao = String(b.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    if (edicao.length > 40) return res.status(400).json({ message: 'O nome da edição passa de 40 caracteres.' });
    const ativa = b.ativa === true || b.ativa === 'true';
    const desconto = Number(b.desconto_livre_pct ?? 0);
    if (!Number.isFinite(desconto) || desconto < 0 || desconto >= 100) {
      return res.status(400).json({ message: 'O desconto livre deve ficar entre 0 e 99,99%.' });
    }
    const validade = Number(b.validade_orcamento_dias ?? 7);
    if (!Number.isInteger(validade) || validade < 1 || validade > 90) {
      return res.status(400).json({ message: 'A validade do orçamento deve ser de 1 a 90 dias.' });
    }

    try {
      await Pg.withTransaction(async (client) => {
        await Edicao.q(client,
          `INSERT INTO tab_ciosp_meta (edicao, ativa, desconto_livre_pct, validade_orcamento_dias, atualizado_em)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (edicao) DO UPDATE SET ativa = $2, desconto_livre_pct = $3,
             validade_orcamento_dias = $4, atualizado_em = NOW()`,
          [edicao, ativa, desconto, validade]);
        if (ativa) {
          await Edicao.q(client, `UPDATE tab_ciosp_meta SET ativa = false WHERE edicao <> $1 AND ativa`, [edicao]);
          await Edicao.semearFormas(client, edicao);
        }
        await Edicao.tocarVersao(client, edicao);
      });
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Edição', acao: 'CONFIGURAR', severidade: 'INFO',
        req, entidade: 'edicao', entidadeId: edicao,
        descricao: `${edicao}: ${ativa ? 'ATIVA' : 'inativa'} · desconto livre ${desconto}% · validade ${validade} dias`
      });
      return res.json(await Edicao.getConfig(app, edicao));
    } catch (err) {
      console.error('ciosp/config (salvar):', err.message);
      return res.status(500).json({ message: 'Erro ao salvar a configuração: ' + err.message });
    }
  }
});
