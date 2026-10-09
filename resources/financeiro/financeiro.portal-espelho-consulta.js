// GET /financeiro/portal-espelho — situação da última geração e prévia do que
// um cliente veria. Serve para conferir o conteúdo ANTES de existir portal.
// Perm 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005, 0]);

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/D/g, '');

module.exports = (app) => ({
  verb: 'get',
  route: '/portal-espelho',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const doc = soDig(req.query.doc);
    try {
      const ultimas = await Pg.connectAndQuery(
        `SELECT id, gerado_em, titulos, clientes, com_boleto, enviados, status, destino, erro, duracao_ms
           FROM tab_portal_publicacao ORDER BY gerado_em DESC LIMIT 5`, {});

      const totais = await Pg.connectAndQuery(
        `SELECT COUNT(*) titulos, COUNT(DISTINCT cliente_doc) clientes,
                COUNT(*) FILTER (WHERE pode_2via) com_2via,
                COUNT(*) FILTER (WHERE situacao = 'vencido') vencidos,
                COUNT(*) FILTER (WHERE NOT tem_boleto AND situacao <> 'pago') sem_boleto,
                COUNT(*) FILTER (WHERE publicado_em IS NULL) pendentes_de_envio
           FROM tab_portal_espelho`, {});

      let cliente = null;
      if (doc) {
        const linhas = await Pg.connectAndQuery(
          `SELECT numero, parcela, vencimento, valor, saldo, situacao, tem_boleto,
                  nosso_numero, linha_digitavel, pode_2via, motivo_2via, data_pagamento
             FROM tab_portal_espelho WHERE cliente_doc = @doc
            ORDER BY situacao, vencimento LIMIT 300`, { doc });
        const cab = await Pg.connectAndQuery(
          `SELECT cliente_nome, contato_telefone, contato_email FROM tab_portal_espelho
            WHERE cliente_doc = @doc LIMIT 1`, { doc });
        // O contato aparece mascarado: quem confere não precisa do número inteiro.
        const mascarar = (v, visiveis) => {
          const s = trim(v);
          return s ? s.slice(0, 2) + '•'.repeat(Math.max(0, s.length - 2 - visiveis)) + s.slice(-visiveis) : null;
        };
        cliente = {
          doc,
          nome: cab[0]?.cliente_nome || null,
          telefone: mascarar(cab[0]?.contato_telefone, 4),
          email: mascarar(cab[0]?.contato_email, 6),
          titulos: linhas
        };
      }

      return res.json({ publicacoes: ultimas, totais: totais[0], cliente });
    } catch (err) {
      console.error('financeiro/portal-espelho (consulta):', err.message);
      return res.status(500).json({ message: 'Erro ao consultar o espelho: ' + err.message });
    }
  }
});
