// POST /cobranca/whatsapp-enviar — envia template SOMENTE para os titulos
// selecionados pelo operador no preview.
// Body: { tipo: 'D-1'|'D0'|'D+3', titulos: [{ filial, prefixo, numero, parcela, cliente_cod, cliente_loja }, ...] }
//
// IMPORTANTE: o backend re-consulta o Protheus pra evitar que o operador
// (ou um cliente malicioso) forge valores ou parametros. Se a chave nao
// estiver mais elegivel pro tipo (titulo pago, vencimento mudou, etc.),
// e ignorada.
//
// Permissao 1030.

// Acessivel pelo operador de Cobranca (9004) e por Tecnologia (1030 — pra debug).
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9004, 1030]);
const Scheduler = require('../../services/scheduler');

const chaveTitulo = (t) => [
  t.filial, t.prefixo, t.numero, t.parcela || '',
  t.cliente_cod, t.cliente_loja
].map(s => String(s || '').trim()).join('|');

module.exports = (app) => ({
  verb: 'post',
  route: '/whatsapp-enviar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus, Suri } = app.services;

    const tipo = String(req.body?.tipo || '').trim();
    const titulosBody = Array.isArray(req.body?.titulos) ? req.body.titulos : [];

    const cfg = Scheduler.TIPOS.find(t => t.tipo === tipo);
    if (!cfg) return res.status(400).json({ message: 'Tipo invalido. Use D-1, D0 ou D+3.' });
    if (!titulosBody.length) return res.status(400).json({ message: 'Forneca ao menos 1 titulo em titulos[].' });

    // Conjunto de chaves solicitadas pelo operador
    const chavesSolicitadas = new Set(titulosBody.map(chaveTitulo));

    try {
      // Re-consulta Protheus pro tipo correto (fonte unica da verdade)
      const candidatos = await Scheduler.buscarTitulos(Protheus, cfg.delta, cfg.mode);
      const elegiveis = candidatos.filter(c => chavesSolicitadas.has(chaveTitulo(c)));

      const stats = {
        tipo,
        solicitados: titulosBody.length,
        elegiveis: elegiveis.length,
        ignorados_inelegiveis: titulosBody.length - elegiveis.length,
        enviados: 0, erros: 0, sem_telefone: 0, ja_enviados: 0,
        detalhes: []
      };

      for (const t of elegiveis) {
        const chave = chaveTitulo(t);
        const phone = Scheduler.extrairTelefone(t, Suri);
        const params = Scheduler.montarParametros(tipo, t);

        if (!phone) {
          await Scheduler.registrarEnvio(Pg, t, tipo, {
            status: 'SEM_TELEFONE', telefone: null, parametros: params,
            erro: 'Sem telefone valido em SA1'
          }).catch(() => { /* ja gravado hoje */ });
          stats.sem_telefone++;
          stats.detalhes.push({ chave, status: 'SEM_TELEFONE', cliente: t.cliente_nome });
          continue;
        }

        const r = await Suri.enviarTemplate({ phone, tipo, parameters: params });

        try {
          await Scheduler.registrarEnvio(Pg, t, tipo, {
            status: r.ok ? 'OK' : 'ERRO',
            telefone: phone, parametros: params,
            wamid: r.wamid, erro: r.erro, response: r.raw
          });
          if (r.ok) {
            stats.enviados++;
            stats.detalhes.push({ chave, status: 'OK', cliente: t.cliente_nome, wamid: r.wamid });
          } else {
            stats.erros++;
            stats.detalhes.push({ chave, status: 'ERRO', cliente: t.cliente_nome, erro: r.erro });
          }
        } catch (e) {
          if (String(e.message).match(/duplicate|unique/i)) {
            stats.ja_enviados++;
            stats.detalhes.push({ chave, status: 'JA_ENVIADO', cliente: t.cliente_nome });
          } else {
            console.error('[whatsapp-enviar] erro ao logar envio:', e.message);
            stats.erros++;
            stats.detalhes.push({ chave, status: 'ERRO', cliente: t.cliente_nome, erro: e.message });
          }
        }
      }

      return res.json({ ok: true, ...stats });
    } catch (err) {
      console.error('whatsapp-enviar:', err);
      return res.status(500).json({ message: 'Erro ao processar envio: ' + err.message });
    }
  }
});
