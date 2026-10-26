// PUT /cobranca/status-titulo-lote/:cod/:loja
// body: { titulos: [{ prefixo, numero, parcela, tipo }], status, observacao }
//
// Define o MESMO status de cobrança para vários títulos do cliente de uma vez —
// a versão em lote do PUT /status-titulo (que faz um por vez). Tudo numa transação:
// ou todos os títulos ficam com o status, ou nenhum muda.
//   - status vazio = remove o status dos títulos (mesmo efeito do "Sem status").
//   - observação vazia MANTÉM a observação que cada título já tinha (no lote, o
//     comum é só trocar o status; não apagar anotações individuais sem querer).
// Perm 9001/9002 (as mesmas do PUT individual).
const { STATUS_SET } = require('../../services/cobrancaStatus');
const trim = (v) => String(v == null ? '' : v).trim();

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);
const MAX_TITULOS = 500;

module.exports = (app) => ({
  verb: 'put',
  route: '/status-titulo-lote/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const cod  = trim(req.params.cod);
    const loja = trim(req.params.loja);
    if (!cod || !loja) return res.status(400).json({ message: 'Cliente é obrigatório.' });

    const b = req.body || {};
    const status = trim(b.status);
    const obs    = trim(b.observacao) || null;
    if (status && !STATUS_SET.has(status)) return res.status(400).json({ message: 'Status inválido.' });
    if (obs && obs.length > 500) return res.status(400).json({ message: 'Observação muito longa (máx. 500 caracteres).' });

    // Normaliza e remove duplicados (mesma chave do título)
    const vistos = new Set();
    const titulos = (Array.isArray(b.titulos) ? b.titulos : [])
      .map(t => ({ prefixo: trim(t && t.prefixo), numero: trim(t && t.numero), parcela: trim(t && t.parcela), tipo: trim(t && t.tipo) }))
      .filter(t => {
        const k = `${t.prefixo}|${t.numero}|${t.parcela}|${t.tipo}`;
        if (!t.numero || vistos.has(k)) return false;
        vistos.add(k); return true;
      });
    if (!titulos.length) return res.status(400).json({ message: 'Selecione ao menos um título.' });
    if (titulos.length > MAX_TITULOS) return res.status(400).json({ message: `Máximo de ${MAX_TITULOS} títulos por vez.` });

    try {
      await Pg.withTransaction(async (client) => {
        for (const t of titulos) {
          if (!status) {
            await client.query(
              `DELETE FROM tab_cobranca_status_titulo
                WHERE cliente_cod=$1 AND cliente_loja=$2
                  AND titulo_prefixo=$3 AND titulo_num=$4 AND titulo_parcela=$5 AND titulo_tipo=$6`,
              [cod, loja, t.prefixo, t.numero, t.parcela, t.tipo]);
          } else {
            await client.query(
              `INSERT INTO tab_cobranca_status_titulo
                 (cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo, status, observacao, id_user)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo) DO UPDATE
                  SET status         = EXCLUDED.status,
                      observacao     = COALESCE(EXCLUDED.observacao, tab_cobranca_status_titulo.observacao),
                      dt_atualizacao = NOW(),
                      id_user        = EXCLUDED.id_user`,
              [cod, loja, t.prefixo, t.numero, t.parcela, t.tipo, status, obs, user.ID]);
          }
        }
      });
      return res.json({ ok: true, qtd: titulos.length, cleared: !status });
    } catch (err) {
      console.error('Erro cobranca/status-titulo-lote:', err);
      return res.status(500).json({ message: 'Erro ao atualizar o status dos títulos. Nenhum título foi alterado.' });
    }
  }
});
