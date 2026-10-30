// POST /qualificacao/regras — cria uma NOVA versão de regra (o PRO 7.3.7 foi revisado,
// ou a Qualidade decidiu a tabela de P). Versões não se editam: cria-se outra.
// body: { nome, referencia, descricao, conteudo, ativar? }. Perm 23006 (Administração).

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const ativarRegra = require('./_ativarRegra');

module.exports = (app) => ({
  verb: 'post',
  route: '/regras',
  middlewares: [Q.mw(app, 'admin')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    try {
      const nome = Q.trim(b.nome).slice(0, 120);
      if (!nome) return res.status(400).json({ message: 'Dê um nome à versão (ex.: "PRO 7.3.7 REV MAR27").' });
      let conteudo = b.conteudo;
      if (typeof conteudo === 'string') { try { conteudo = JSON.parse(conteudo); } catch { return res.status(400).json({ message: 'Conteúdo não é um JSON válido.' }); } }
      const erros = R.validarRegra(conteudo);
      if (erros.length) return res.status(400).json({ message: erros[0], erros });
      const u = Q.usuario(req);
      const [r] = await Pg.connectAndQuery(
        `INSERT INTO tab_qf_regra_versao (nome, referencia, descricao, conteudo, criado_por) VALUES (@n, @ref, @d, @c::jsonb, @u) RETURNING id, nome`,
        { n: nome, ref: Q.nul(b.referencia), d: Q.nul(b.descricao), c: JSON.stringify(conteudo), u: u.id });
      await Q.log(Pg, req, { entidade: 'regra', entidadeId: r.id, acao: 'CRIAR', mudancas: [{ campo: 'nome', para: nome }], motivo: b.descricao });
      let ativacao = null;
      if (b.ativar) ativacao = await ativarRegra(app, req, r.id, Q.nul(b.motivo) || 'nova versão criada e ativada');
      return res.json({ ok: true, regra: r, ativacao });
    } catch (err) { return Q.falha(res, 'criar a versão de regra', err); }
  }
});
