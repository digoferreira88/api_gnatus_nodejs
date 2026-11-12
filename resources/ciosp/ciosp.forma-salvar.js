// POST /ciosp/formas — cria (sem id) ou altera (com id) uma forma de pagamento da
// edição. Perm 19004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'post',
  route: '/formas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const b = req.body || {};
    const edicao = String(b.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    const { erro, forma } = Edicao.validarForma(b);
    if (erro) return res.status(400).json({ message: erro });
    const id = b.id ? Number(b.id) : null;
    const v = [forma.ordem, forma.nome, forma.coluna_base, forma.desconto_pct, forma.parcelas_max,
      forma.exige_credito, forma.financeira, forma.ativo];

    try {
      let rows;
      if (id) {
        rows = await Edicao.q(app,
          `UPDATE tab_ciosp_forma_pagto SET ordem=$1, nome=$2, coluna_base=$3, desconto_pct=$4, parcelas_max=$5,
                  exige_credito=$6, financeira=$7, ativo=$8, atualizado_em=NOW()
            WHERE id = $9 AND edicao = $10 RETURNING id`, [...v, id, edicao]);
        if (!rows.length) return res.status(404).json({ message: 'Forma de pagamento não encontrada.' });
      } else {
        rows = await Edicao.q(app,
          `INSERT INTO tab_ciosp_forma_pagto (ordem, nome, coluna_base, desconto_pct, parcelas_max,
                  exige_credito, financeira, ativo, edicao)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [...v, edicao]);
      }
      await Edicao.tocarVersao(app, edicao);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Formas de pagamento', acao: id ? 'ALTERAR' : 'CRIAR', severidade: 'INFO',
        req, entidade: 'forma_pagto', entidadeId: rows[0].id,
        descricao: `${edicao}: ${forma.nome} (${forma.coluna_base}, ${forma.desconto_pct}%)`
      });
      return res.json({ ok: true, id: rows[0].id });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: 'Já existe uma forma com esse nome nesta edição.' });
      console.error('ciosp/formas (salvar):', err.message);
      return res.status(500).json({ message: 'Erro ao salvar a forma de pagamento: ' + err.message });
    }
  }
});
