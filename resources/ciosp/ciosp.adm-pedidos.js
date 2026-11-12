// GET /ciosp/adm/pedidos?edicao=&situacao=&busca=&meus=1 — fila do ADM. Perm 19004.
//
// Sem edição, usa a edição ativa. Rascunho não aparece (ainda é do vendedor). Quem
// espera atendimento (enviado, em análise) vem por ordem de chegada; o resto, do mais
// recente para o mais antigo.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const { trim } = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const E = require('../../services/ciospEdicao');

const NA_FILA = ['enviado', 'em_analise', 'devolvido', 'conferido', 'finalizado', 'cancelado'];

module.exports = (app) => ({
  verb: 'get',
  route: '/adm/pedidos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;

    try {
      const edicao = trim(req.query.edicao) || (await E.getConfig(app)).edicao;
      const contagem = Object.fromEntries(NA_FILA.map(s => [s, 0]));
      if (!edicao) return res.json({ edicao: null, contagem, pedidos: [] });

      const p = { edicao };
      const cond = [`p.edicao = @edicao`, `p.situacao <> 'rascunho'`];
      const situacao = trim(req.query.situacao);
      if (NA_FILA.includes(situacao)) { cond.push('p.situacao = @situacao'); p.situacao = situacao; }
      if (trim(req.query.meus) === '1' && uid) { cond.push('p.adm_responsavel = @eu'); p.eu = uid; }
      const busca = trim(req.query.busca);
      if (busca) {
        cond.push(`(p.cliente_nome ILIKE @busca OR p.vendedor_nome ILIKE @busca
                    OR p.cliente_doc LIKE @buscaDoc OR CAST(p.numero AS TEXT) = @buscaNum
                    OR p.protheus_pedido = @buscaProtheus)`);
        p.busca = `%${busca}%`;
        const dig = busca.replace(/\D/g, '');
        p.buscaDoc = dig ? `%${dig}%` : '-';
        p.buscaNum = dig ? String(Number(dig)) : '-1';
        p.buscaProtheus = dig ? dig.padStart(6, '0') : '-';
      }

      const [linhas, cont] = await Promise.all([
        Pg.connectAndQuery(
          `SELECT p.id, p.uuid, p.numero, p.cliente_nome, p.cliente_doc, p.vendedor_nome, p.total,
                  p.situacao, p.enviado_em, p.atualizado_em, p.adm_responsavel, u.nome AS adm_nome,
                  f.nome AS forma_nome, p.tabela_comissao, p.credito_status, p.contrato_assinado_em,
                  p.protheus_pedido, p.protheus_conferido, p.venda_id, p.devolvido_motivo,
                  EXISTS (SELECT 1 FROM tab_ciosp_pedido_item i
                           WHERE i.pedido_id = p.id AND i.promocao_condicional) AS tem_condicional
             FROM tab_ciosp_pedido p
             LEFT JOIN tab_intranet_usr u ON u.id = p.adm_responsavel
             LEFT JOIN tab_ciosp_forma_pagto f ON f.id = p.forma_pagto_id
            WHERE ${cond.join(' AND ')}
            ORDER BY CASE WHEN p.situacao IN ('enviado', 'em_analise') THEN 0 ELSE 1 END,
                     CASE WHEN p.situacao IN ('enviado', 'em_analise') THEN p.enviado_em END ASC,
                     p.atualizado_em DESC
            LIMIT 300`, p),
        Pg.connectAndQuery(
          `SELECT situacao, COUNT(*)::int AS n FROM tab_ciosp_pedido
            WHERE edicao = @edicao AND situacao <> 'rascunho' GROUP BY situacao`, { edicao })
      ]);
      for (const c of cont) if (c.situacao in contagem) contagem[c.situacao] = c.n;

      return res.json({
        edicao,
        contagem,
        pedidos: linhas.map(l => ({
          ...l,
          total: Number(l.total),
          pendencias: l.situacao === 'conferido' ? F.pendenciasFinalizar(l) : []
        }))
      });
    } catch (err) {
      console.error('ciosp/adm-pedidos:', err.message);
      return res.status(500).json({ message: 'Erro ao carregar a fila: ' + err.message });
    }
  }
});
