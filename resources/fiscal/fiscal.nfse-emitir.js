// POST /fiscal/nfse/emitir
// Emite a NFS-e (Padrão Nacional/DPS) de uma ou várias NF de serviço (série C).
// Body: { serie?, doc, cliente, loja } OU { notas: [{serie,doc,cliente,loja}, ...] }.
// Orquestração em services/nfseEmissao (lê Protheus, monta+assina+envia, grava).
// Trava de emissão dupla no próprio serviço. Perm 16001. Audita CRÍTICO.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Auditoria = require('../../services/auditoria');
const { emitirNota, config } = require('../../services/nfseEmissao');

const trim = (v) => String(v == null ? '' : v).trim();
const MAX = 50;

module.exports = (app) => ({
  verb: 'post',
  route: '/nfse/emitir',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    const body = req.body || {};
    const observacao = trim(body.observacao);   // opcional: sai na descrição do serviço (todas as notas do lote)
    let notas = Array.isArray(body.notas) ? body.notas : [body];
    notas = notas
      .map((n) => ({ serie: trim(n.serie) || 'C', doc: trim(n.doc), cliente: trim(n.cliente), loja: trim(n.loja) }))
      .filter((n) => n.doc && n.cliente && n.loja);

    if (!notas.length) return res.status(400).json({ message: 'Informe ao menos uma nota (doc, cliente, loja).' });
    if (notas.length > MAX) return res.status(400).json({ message: `Máximo de ${MAX} notas por emissão (recebidas ${notas.length}).` });

    const { ambienteRotulo } = config();
    const resultados = [];
    for (const n of notas) {
      try {
        const r = await emitirNota(app, { ...n, user, observacao });
        resultados.push({ ...n, ...r });
      } catch (e) {
        resultados.push({ ...n, ok: false, erro: 'EXCECAO', mensagem: e.message });
      }
    }

    const emitidas = resultados.filter((r) => r.ok && !r.jaEmitida).length;
    const jaEmitidas = resultados.filter((r) => r.jaEmitida).length;
    const excluidas = resultados.filter((r) => r.excluida).length;   // cliente suspenso (não é falha)
    const falhas = resultados.filter((r) => !r.ok && !r.excluida).length;

    Auditoria.registrar(app, {
      modulo: 'Fiscal', submodulo: 'NFSe',
      acao: 'EMITIR_NFSE', severidade: falhas ? 'ALERTA' : 'CRITICO', req,
      entidade: 'nfse', entidadeId: notas.map((n) => `${n.serie}/${n.doc}`).slice(0, 5).join(','),
      descricao: `Emissão NFS-e (${ambienteRotulo}): ${emitidas} emitida(s), ${jaEmitidas} já existia(m), ${excluidas} excluída(s), ${falhas} falha(s) de ${notas.length}.`,
      meta: { ambiente: ambienteRotulo, total: notas.length, emitidas, jaEmitidas, excluidas, falhas }
    });

    return res.json({
      ambiente: ambienteRotulo,
      resumo: { total: notas.length, emitidas, jaEmitidas, excluidas, falhas },
      resultados
    });
  }
});
