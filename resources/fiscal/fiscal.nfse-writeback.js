// POST /fiscal/nfse/writeback — reconcilia o writeback da chave NFS-e no Protheus.
// Body: { simular?:bool (DEFAULT true), limite?:int, id?:int }.
//   simular=true  -> dry-run: valida/localiza a nota no Protheus, NÃO grava.
//   simular=false -> grava de verdade (GRAVADO/JA_GRAVADO -> writeback='OK').
// GUARDA: só toca linhas EMITIDA de ambiente='producao' (ver services/nfseWriteback).
// Chama GET /NFSe/diag antes; se campos_ok=false devolve 503 sem enviar nada.
// Perm 16001. Audita CRÍTICO só na gravação real (não polui log com dry-run).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Auditoria = require('../../services/auditoria');
const { reconciliar } = require('../../services/nfseWriteback');

module.exports = (app) => ({
  verb: 'post',
  route: '/nfse/writeback',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const body = req.body || {};
    const simular = body.simular === false ? false : true;   // default seguro: dry-run
    const limite = body.limite;
    const id = body.id != null ? (parseInt(body.id, 10) || null) : null;

    let r;
    try {
      r = await reconciliar(app, { simular, limite, id });
    } catch (e) {
      return res.status(500).json({ ok: false, message: 'Erro na reconciliação de writeback: ' + e.message });
    }

    if (!r.ok && r.erro === 'CAMPOS_INDISPONIVEIS') return res.status(503).json(r);
    if (!r.ok) return res.status(500).json(r);

    if (!simular && r.resumo && (r.resumo.gravadas || r.resumo.divergentes)) {
      Auditoria.registrar(app, {
        modulo: 'Fiscal', submodulo: 'NFSe', acao: 'WRITEBACK_NFSE', severidade: 'CRITICO', req,
        entidade: 'nfse',
        entidadeId: r.resultados.filter((x) => x.gravou).map((x) => x.doc).slice(0, 5).join(','),
        descricao: `Writeback NFS-e no Protheus: ${r.resumo.gravadas} gravada(s), ${r.resumo.divergentes} divergente(s), ${r.resumo.falhas} falha(s) de ${r.resumo.candidatas}.`,
        meta: r.resumo
      });
    }

    return res.json(r);
  }
});
