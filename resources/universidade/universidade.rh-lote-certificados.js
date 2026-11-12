// GET /universidade/rh/lote/:id/certificados — certificados (1 PDF) de todos os
// participantes APROVADOS e não anulados de um lançamento. Perm 15004/15005/15003.

const { LER, requirePerm, usuario, audit } = require('./_rh');
const Cert = require('../../services/universidadeCertificado');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/lote/:id/certificados',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID inválido.' });

    const regs = await Pg.connectAndQuery(`
      SELECT r.id FROM tab_uni_registro r JOIN tab_uni_colaborador c ON c.id = r.colaborador_id
       WHERE r.lote_id = @id AND NOT r.anulado AND r.resultado = 'aprovado'
       ORDER BY c.nome`, { id });
    if (!regs.length) return res.status(404).json({ message: 'Nenhum participante aprovado neste lançamento.' });

    const u = usuario(req);
    const itens = [];
    for (const r of regs) {
      const d = await Cert.dadosCertificado(Pg, `registro:${r.id}`);
      if (!d) continue;
      itens.push({ dados: d, emissao: await Cert.registrarEmissao(Pg, d, u.ID) });
    }
    const pdf = await Cert.gerarPdf(itens);
    await audit(app, req, 'EMITIR', 'uni_registro_lote', id, `Certificados do lançamento ${id}: ${itens.length}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificados-lancamento-${id}.pdf"`);
    return res.send(pdf);
  }
});
