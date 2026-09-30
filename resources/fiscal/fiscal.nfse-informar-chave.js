// POST /fiscal/nfse/informar-chave  — body: { id, chave }
// Reconciliação MANUAL de uma NFS-e órfã: a nota FOI gerada na prefeitura mas nossa
// resposta veio como erro (timeout do ADN nacional — 504/"já escriturada"/"chave já
// compartilhada com o ADN"), então o registro ficou REJEITADA/ERRO sem a chave. O fiscal
// copia a chave de acesso (50 díg.) do portal cidadaoonline e informa aqui: o registro
// passa a EMITIDA e fica pronto pro writeback (POST /fiscal/nfse/writeback).
// NÃO chama a prefeitura — é só consolidação interna. Perm 16001. Audita CRÍTICO.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Auditoria = require('../../services/auditoria');
const { cnpjPrestador } = require('../../services/nfseEmissao');

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');

module.exports = (app) => ({
  verb: 'post',
  route: '/nfse/informar-chave',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const por = trim(user && (user.EMAIL || user.NOME)) || 'sistema';

    const id = parseInt(req.body && req.body.id, 10) || 0;
    const chave = soDig(req.body && req.body.chave);

    if (!id) return res.status(400).json({ message: 'id é obrigatório.' });
    if (chave.length !== 50) return res.status(400).json({ message: 'A chave da NFS-e Nacional tem 50 dígitos (recebidos ' + chave.length + ').' });
    const cnpj = cnpjPrestador();
    if (cnpj && cnpj.length === 14 && !chave.includes(cnpj)) {
      return res.status(400).json({ message: 'A chave não contém o CNPJ do prestador (' + cnpj + ') — confira se copiou a chave certa.' });
    }

    try {
      const row = (await Pg.connectAndQuery(
        `SELECT id, serie, doc, cliente, loja, ambiente, status, nfse_chave, cliente_nome, valor
           FROM tab_nfse_emitida WHERE id = @id`, { id }))[0];
      if (!row) return res.status(404).json({ message: 'Registro não encontrado.' });
      if (trim(row.status) === 'EMITIDA') {
        return res.status(409).json({ message: 'Este documento já está EMITIDA (chave ' + trim(row.nfse_chave) + ').' });
      }

      // chave já registrada em outra linha?
      const dup = await Pg.connectAndQuery(
        `SELECT id FROM tab_nfse_emitida WHERE nfse_chave = @c AND id <> @id`, { c: chave, id });
      if (dup.length) return res.status(409).json({ message: 'Esta chave já está registrada em outra emissão (id ' + dup[0].id + ').' });

      // já existe EMITIDA para o mesmo documento/ambiente? (o índice único bloquearia)
      const ja = await Pg.connectAndQuery(
        `SELECT id FROM tab_nfse_emitida
          WHERE serie=@s AND doc=@d AND cliente=@cli AND loja=@l AND ambiente=@a AND status='EMITIDA' AND id<>@id`,
        { s: row.serie, d: row.doc, cli: row.cliente, l: row.loja, a: row.ambiente, id });
      if (ja.length) return res.status(409).json({ message: 'Já existe uma NFS-e EMITIDA para este documento (id ' + ja[0].id + ').' });

      const upd = (await Pg.connectAndQuery(`
        UPDATE tab_nfse_emitida
           SET status='EMITIDA', nfse_chave=@c, erros='[]'::jsonb,
               retorno = jsonb_build_object('ok', true, 'httpStatus', 201, 'reconciliadoManual', true, 'reconciliadoPor', @por, 'reconciliadoEm', to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SSOF')),
               emitido_por = COALESCE(NULLIF(emitido_por,''), @por),
               emitido_em = COALESCE(emitido_em, NOW()),
               atualizado_em = NOW()
         WHERE id=@id AND status <> 'EMITIDA'
        RETURNING id, status, nfse_chave, writeback`, { c: chave, por, id }))[0];
      if (!upd) return res.status(409).json({ message: 'Não foi possível reconciliar (o status mudou; recarregue e tente de novo).' });

      Auditoria.registrar(app, {
        modulo: 'Fiscal', submodulo: 'NFSe', acao: 'INFORMAR_CHAVE_NFSE', severidade: 'CRITICO', req,
        entidade: 'nfse', entidadeId: `${trim(row.serie)}/${trim(row.doc)}`,
        descricao: `Chave informada manualmente (reconciliação de nota órfã por timeout do ADN) para ${trim(row.serie)}/${trim(row.doc)} — ${trim(row.cliente_nome)}: ${chave}`,
        antes: { status: trim(row.status), chave: trim(row.nfse_chave) },
        depois: { status: 'EMITIDA', chave },
        meta: { id, doc: trim(row.doc), cliente: trim(row.cliente), loja: trim(row.loja), ambiente: trim(row.ambiente), valor: Number(row.valor || 0), chave }
      });

      return res.json({ ok: true, id: upd.id, status: trim(upd.status), chave: trim(upd.nfse_chave), writeback: trim(upd.writeback) });
    } catch (err) {
      if ((err && err.code === '23505') || /duplicate key|unique|índice/i.test(err.message || '')) {
        return res.status(409).json({ message: 'Já existe uma emissão ativa para este documento neste ambiente (conflito de índice único).' });
      }
      console.error('fiscal/nfse-informar-chave:', err.message);
      return res.status(500).json({ message: 'Erro ao informar chave: ' + err.message });
    }
  }
});
