// PUT /cobranca/filtro-status — grava a config GLOBAL do "filtro escondido".
// Body: { statusExcluidos: string[] } — os status a EXCLUIR do dashboard quando o
// checkbox cego é ligado. Valida contra STATUS_SET, deduplica. Perm 9005 (gestora).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9005, 0]);
const Auditoria = require('../../services/auditoria');
const { STATUS_SET } = require('../../services/cobrancaStatus');

module.exports = (app) => ({
  verb: 'put',
  route: '/filtro-status',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];

    const entrada = Array.isArray(req.body && req.body.statusExcluidos) ? req.body.statusExcluidos : null;
    if (!entrada) return res.status(400).json({ message: 'statusExcluidos deve ser uma lista.' });

    const validos = [...new Set(entrada.map((s) => String(s || '').trim().toUpperCase()))]
      .filter((s) => STATUS_SET.has(s));

    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_cobranca_filtro_status (id, status_excluidos, atualizado_por, atualizado_em)
        VALUES (1, @arr::jsonb, @uid, NOW())
        ON CONFLICT (id) DO UPDATE SET
          status_excluidos = EXCLUDED.status_excluidos,
          atualizado_por   = EXCLUDED.atualizado_por,
          atualizado_em    = NOW()`,
        { arr: JSON.stringify(validos), uid: user ? user.ID : null });

      Auditoria.registrar(app, {
        modulo: 'Cobranca', submodulo: 'FiltroStatus',
        acao: 'UPSERT', severidade: 'INFO',
        req, entidade: 'cobranca_filtro_status', entidadeId: '1',
        descricao: `Atualizou filtro escondido de status (${validos.length} excluídos): ${validos.join(', ') || '(nenhum)'}`,
        meta: { statusExcluidos: validos }
      });

      return res.json({ ok: true, statusExcluidos: validos });
    } catch (err) {
      console.error('cobranca/filtro-status PUT:', err);
      return res.status(500).json({ message: 'Erro ao salvar o filtro de status.' });
    }
  }
});
