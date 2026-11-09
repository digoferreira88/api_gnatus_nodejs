// GET /cobranca/notificacao-lista?tipo=PROTESTO — títulos vencidos (só boleto)
// candidatos à notificação formal, com contato do cliente, status de cobrança
// (do título e do cliente) e a última notificação enviada por canal.
// Perm 9009 (admin 0 passa sempre).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9009]);
const Notif = require('../../services/cobrancaNotificacao');
const CobrancaStatus = require('../../services/cobrancaStatus');

module.exports = (app) => ({
  verb: 'get',
  route: '/notificacao-lista',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus, Suri } = app.services;
    const cfg = Notif.tipoCfg(req.query.tipo || 'PROTESTO');
    if (!cfg) return res.status(400).json({ message: 'Tipo de notificação inválido.' });

    try {
      const [rows, stTit, stCli, ultimas] = await Promise.all([
        Notif.buscarVencidos(Protheus),
        Notif.statusTitulos(Pg),
        Notif.statusClientes(Pg),
        Notif.ultimasNotificacoes(Pg, cfg.tipo)
      ]);

      // Ordena no Node: o nome vem com espaço à esquerda em alguns cadastros e o
      // ORDER BY do SQL Server deixava esses fora da ordem alfabética.
      const porNome = (a, b) => a.cliente_nome.localeCompare(b.cliente_nome, 'pt-BR')
        || a.cliente_cod.localeCompare(b.cliente_cod) || a.cliente_loja.localeCompare(b.cliente_loja)
        || a.vencimento.localeCompare(b.vencimento) || a.numero.localeCompare(b.numero)
        || a.parcela.localeCompare(b.parcela);
      const titulos = rows.map(r => Notif.normalizar(r, Suri)).sort(porNome).map(t => {
        const st = stTit.get(t.chave);
        return {
          ...t,
          status_titulo: st ? st.status : null,
          status_titulo_obs: st ? st.observacao : null,
          status_cliente: stCli.get(Notif.chaveCliente(t)) || null,
          ultima: ultimas.get(t.chave) || null
        };
      });

      return res.json({
        tipo: cfg.tipo,
        tipos: Object.values(Notif.TIPOS).map(t => ({ tipo: t.tipo, label: t.label, titulo: t.titulo })),
        status_ordem: cfg.statusOrdem,
        // Rótulos vindos da lista canônica (a tela não mantém cópia própria).
        status_labels: CobrancaStatus.LABELS,
        hoje: Notif.hojeBR(),
        titulos,
        gerado_em: new Date().toISOString()
      });
    } catch (err) {
      console.error('cobranca/notificacao-lista:', err);
      return res.status(500).json({ message: 'Erro ao montar a lista: ' + err.message });
    }
  }
});
