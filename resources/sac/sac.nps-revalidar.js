// POST /sac/nps/revalidar  { id, dias? }
//
// Revalida o link de um convite cujo prazo venceu, para o CX poder reenviar ao
// cliente (por e-mail, WhatsApp ou copiando o link). Só estende a validade:
// o token e o status continuam os mesmos.
//
// "Expirado" NAO e' um status gravado: o convite segue 'ENVIADO' e quem vence
// e' a coluna expira_em — quem barra o acesso sao os endpoints publicos
// (nps.publico-get / nps.publico-responder), comparando expira_em com NOW().
// Por isso revalidar é só empurrar essa data.
//
// Convite JA RESPONDIDO nao e' reaberto (decisao do CX em 16/09/2026): a
// resposta do cliente fica intacta e o dashboard nao muda. Para pesquisar o
// mesmo cliente de novo, gere um novo convite pelo pedido (/sac/nps/link).
//
// Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const Auditoria = require('../../services/auditoria');
const NPS = require('../../services/npsPosvenda');

const trim = (v) => String(v == null ? '' : v).trim();

// Motivo pelo qual um convite nao pode ser revalidado (null = pode).
function bloqueio(status) {
  const s = trim(status).toUpperCase();
  if (s === 'RESPONDIDO') return 'O cliente já respondeu esta pesquisa. Revalidar não reabre a resposta — se precisar pesquisar de novo, gere um novo link pelo pedido.';
  if (s === 'DESCARTADO') return 'Este convite foi descartado (cliente não deve ser pesquisado). Se mudou de ideia, gere um novo link pelo pedido.';
  if (s === 'REVISAO') return 'Este convite está em revisão pela trava do SAC. Decida em "Em revisão" (enviar ou descartar) antes de revalidar.';
  return null;
}

module.exports = (app) => ({
  verb: 'post',
  route: '/nps/revalidar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const id = Number(b.id);
    if (!id) return res.status(400).json({ message: 'Convite (id) obrigatório.' });

    // dias explicito e' opcional; por padrao usa o mesmo prazo da configuracao.
    let dias = Number(b.dias);
    if (!Number.isFinite(dias) || dias <= 0) dias = 0;
    if (dias > 365) return res.status(400).json({ message: 'Prazo máximo de 365 dias.' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, token, pedido, cliente_nome, status, expira_em, respondido_em
           FROM tab_nps_convite WHERE id = @id`, { id });
      if (!rows.length) return res.status(404).json({ message: 'Convite não encontrado.' });
      const c = rows[0];

      const motivo = bloqueio(c.status);
      if (motivo) return res.status(409).json({ ok: false, codigo: 'NAO_REVALIDAVEL', status: trim(c.status), message: motivo });

      if (!dias) {
        const cfg = await NPS.lerConfig(Pg);
        dias = Number(cfg.expiraDias) > 0 ? Number(cfg.expiraDias) : 30;
      }

      const expiraAntes = c.expira_em;
      const upd = await Pg.connectAndQuery(
        `UPDATE tab_nps_convite
            SET expira_em = NOW() + (@dias || ' days')::interval
          WHERE id = @id
      RETURNING expira_em`, { id, dias: String(dias) });

      const expiraEm = upd[0] && upd[0].expira_em;
      const link = NPS.linkPesquisa(trim(c.token));

      Auditoria.registrar(app, {
        modulo: 'SAC', submodulo: 'NPS',
        acao: 'NPS_REVALIDAR', severidade: 'INFO', req,
        entidade: 'nps_convite', entidadeId: String(id),
        descricao: `Revalidou o link da pesquisa do pedido ${trim(c.pedido)} (${trim(c.cliente_nome) || 'cliente'}) por ${dias} dia(s)`,
        antes: { expira_em: expiraAntes, status: trim(c.status) },
        depois: { expira_em: expiraEm, status: trim(c.status) },
        meta: { pedido: trim(c.pedido), dias }
      });

      return res.json({
        ok: true,
        id,
        status: trim(c.status),
        expiraEm,
        expiraAntes,
        dias,
        link,
        // Revalidar nao envia nada: quem reenvia e' o CX, pelos botoes da tela.
        message: `Link válido por mais ${dias} dia(s). Reenvie ao cliente por e-mail, WhatsApp ou copiando o link.`
      });
    } catch (err) {
      console.error('sac/nps-revalidar:', err);
      return res.status(500).json({ message: 'Erro ao revalidar o link: ' + err.message });
    }
  }
});
