// POST /gerencia/cc-depara — upsert de um de-para fornecedor -> CC.
// Body: { fornece, loja?, cc, observacao? }  (loja vazia = todas as lojas)
// Valida o CC na CTT010. Perm 10001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/cc-depara',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const fornece = trim(b.fornece), loja = trim(b.loja), cc = trim(b.cc);
    const observacao = trim(b.observacao).slice(0, 500) || null;

    if (!fornece) return res.status(400).json({ message: 'Informe o código do fornecedor.' });
    if (!cc) return res.status(400).json({ message: 'Informe o centro de custo.' });

    try {
      // valida CC (best-effort — se o Protheus estiver fora, aceita mesmo assim)
      try {
        const ctt = await Protheus.connectAndQuery(
          `SELECT TOP 1 RTRIM(CTT_DESC01) descricao FROM CTT010 WITH (NOLOCK)
            WHERE D_E_L_E_T_ <> '*' AND RTRIM(CTT_CUSTO) = @cc`, { cc });
        if (!ctt.length) return res.status(400).json({ message: `Centro de custo ${cc} não encontrado na CTT010.` });
      } catch (e) { console.warn('cc-depara salvar: validação CTT indisponível:', e.message); }

      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_cc_fornecedor_depara (fornece, loja, cc, observacao, atualizado_por, atualizado_em)
        VALUES (@f, @l, @cc, @obs, @uid, NOW())
        ON CONFLICT (fornece, loja) DO UPDATE SET
          cc=@cc, observacao=@obs, atualizado_por=@uid, atualizado_em=NOW()
        RETURNING id`,
        { f: fornece, l: loja, cc, obs: observacao, uid: user?.ID || null });

      Auditoria.registrar(app, {
        modulo: 'Gerência', submodulo: 'DRE-CC', acao: 'DEPARA_CC', severidade: 'INFO', req,
        entidade: 'cc_fornecedor_depara', entidadeId: String(r[0].id),
        descricao: `De-para fornecedor ${fornece}${loja ? '/' + loja : ''} -> CC ${cc}`,
        meta: { fornece, loja, cc }
      });

      return res.json({ ok: true, id: r[0].id });
    } catch (err) {
      console.error('gerencia/cc-depara salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
