// GET /universidade/certificado/evidencia?ref=registro:123 — certificado (PDF) de um
// treinamento concluído/aprovado. ref = evidência: registro:N | inscricao:N | matricula:N.
// Pode baixar: o próprio colaborador, o RH (15004/15005/15003/0) ou o gestor do setor dele.
// Cada emissão fica registrada em tab_uni_certificado (código único).

const { usuario, colaboradorDoUsuario, setoresDoGestor, audit } = require('./_rh');
const Cert = require('../../services/universidadeCertificado');

async function ehRh(Pg, uid) {
  const r = await Pg.connectAndQuery(
    `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao IN (0, 15003, 15004, 15005) LIMIT 1`, { id: uid });
  return r.length > 0;
}

module.exports = (app) => ({
  verb: 'get',
  route: '/certificado/evidencia',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const ref = String(req.query.ref || '').trim();
    if (!/^(registro|inscricao|matricula):\d+$/.test(ref)) return res.status(400).json({ message: 'Referência inválida.' });

    const d = await Cert.dadosCertificado(Pg, ref);
    if (!d) return res.status(404).json({ message: 'Treinamento não encontrado ou sem aprovação — não há certificado.' });

    let pode = await ehRh(Pg, u.ID);
    if (!pode) {
      const eu = await colaboradorDoUsuario(Pg, u);
      if (eu && eu.id === d.colaboradorId) pode = true;
      else if (eu && eu.ativo) {
        const setores = await setoresDoGestor(Pg, eu.cpf);
        pode = setores.some(s => s.codigo === d.deptoCodigo);
      }
    }
    if (!pode) return res.status(403).json({ message: 'Você não tem acesso a este certificado.' });

    const emissao = await Cert.registrarEmissao(Pg, d, u.ID);
    const pdf = await Cert.gerarPdf([{ dados: d, emissao }]);
    await audit(app, req, 'EMITIR', 'uni_certificado', emissao.codigo, `Certificado ${emissao.codigo} — ${d.nome} — ${d.cursoCodigo}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificado-${emissao.codigo}.pdf"`);
    return res.send(pdf);
  }
});
