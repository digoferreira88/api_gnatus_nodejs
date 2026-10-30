// PUT /qualificacao/fichas/:fid/respostas — transcreve um FORM 7.3.21/7.3.28 que o fornecedor
// mandou em papel/PDF (anexe o original em /anexos, entidade "ficha"). Mesmas validações do
// link público. Perm 23003+ (Engenharia recebe a ficha — PRO 4.1/5.4).

const Q = require('../../services/qfCore');
const { ErroFicha, gravarRespostas } = require('../../services/qfFicha');

module.exports = (app) => ({
  verb: 'put',
  route: '/fichas/:fid/respostas',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const fid = Number(req.params.fid);
    try {
      const [ficha] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_ficha WHERE id = @id`, { id: fid });
      if (!ficha) return res.status(404).json({ message: 'Ficha não encontrada.' });
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: ficha.fornecedor_id });
      const r = await gravarRespostas(Pg, ficha, f, req.body || {}, { ip: Q.ipDe(req) });
      await Q.log(Pg, req, { entidade: 'ficha', entidadeId: fid, fornecedorId: f.id, acao: 'TRANSCREVER',
        mudancas: [{ campo: 'formulario', para: ficha.formulario }, { campo: 'respostas', para: r.respostas }, { campo: 'em_branco', para: r.emBranco },
          ...(r.placar ? [{ campo: 'pontuacao_percentual', para: r.placar.percentual }] : [])], motivo: 'transcrição interna da ficha recebida' });
      return res.json({ ok: true, ...r });
    } catch (err) {
      if (err instanceof ErroFicha) return res.status(err.status).json({ message: err.message, erros: err.erros });
      return Q.falha(res, 'gravar as respostas', err);
    }
  }
});
