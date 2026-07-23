// GET /sac/nps/envios?inicio=&fim=&status=&busca=&formato=csv
// Lista os convites da pesquisa para tratativa do CX (reenviar por outro canal).
// Traz contato (telefone do convite + e-mail vivo da SA1) e o LINK público da
// pesquisa (token) para o CX copiar e enviar por e-mail/ligação. Perm 6003.
//
// status: filtra c.status. Default = os "acionáveis" (ENVIADO/RESPONDIDO/ERRO);
//   'nao_respondido' = enviados sem resposta e não expirados (foco da tratativa).
// DESCARTADO (não-COV) e PENDENTE ficam de fora por padrão.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const BASE = () => (process.env.NPS_BASE_URL || 'https://intranew.gnatus.com.br').replace(/\/$/, '');

const csvCell = (v) => {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return /[",;\n]/.test(s) ? `"${s}"` : s;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/nps/envios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const q = req.query || {};
    const conds = [], p = {};

    const status = trim(q.status).toUpperCase();
    if (status === 'NAO_RESPONDIDO') {
      conds.push("c.status = 'ENVIADO' AND (c.expira_em IS NULL OR c.expira_em > NOW())");
    } else if (['ENVIADO', 'RESPONDIDO', 'ERRO', 'REVISAO'].includes(status)) {
      conds.push('c.status = @status'); p.status = status;
    } else {
      conds.push("c.status IN ('ENVIADO','RESPONDIDO','ERRO','REVISAO')");   // acionáveis (REVISAO = travado pelo SAC)
    }
    if (trim(q.inicio)) { conds.push('c.criado_em >= @inicio'); p.inicio = trim(q.inicio); }
    if (trim(q.fim))    { conds.push('c.criado_em < (@fim::date + 1)'); p.fim = trim(q.fim); }
    if (trim(q.busca)) {
      conds.push('(c.cliente_nome ILIKE @busca OR c.empresa ILIKE @busca OR c.pedido ILIKE @busca OR c.nf ILIKE @busca OR c.cnpj ILIKE @busca)');
      p.busca = `%${trim(q.busca)}%`;
    }

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT c.id, c.token, c.pedido, c.cliente_cod, c.cliente_loja, c.cliente_nome, c.empresa, c.cnpj,
               c.telefone, c.nf, c.valor_pedido, c.produto_desc, c.data_faturamento,
               c.bu_nome, c.vendedor_nome, c.status, c.classificacao, c.nota_nps,
               c.enviado_em, c.respondido_em, c.lembrete_em, c.expira_em, c.envio_resposta,
               c.email_enviado_em, c.email_destino, c.sac_ocorrencias, c.sac_verificado_em
          FROM tab_nps_convite c
         WHERE ${conds.join(' AND ')}
         ORDER BY c.enviado_em DESC NULLS LAST, c.criado_em DESC
         LIMIT 2000`, p);

      // e-mail vivo da SA1 (best-effort: se o Protheus falhar, segue sem e-mail)
      const emailPorCli = new Map();
      const chaves = [...new Set(rows.map(r => `${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`))].filter(k => k !== '|');
      if (chaves.length && Protheus) {
        try {
          const cods = [...new Set(rows.map(r => trim(r.cliente_cod)).filter(Boolean))];
          const pin = {}; cods.forEach((c, i) => { pin[`c${i}`] = c; });
          const inList = cods.map((_, i) => `@c${i}`).join(',');
          const sa1 = await Protheus.connectAndQuery(
            `SELECT RTRIM(A1_COD) COD, RTRIM(A1_LOJA) LOJA, RTRIM(A1_EMAIL) EMAIL
               FROM SA1010 WITH (NOLOCK) WHERE D_E_L_E_T_<>'*' AND RTRIM(A1_COD) IN (${inList})`, pin);
          sa1.forEach(s => emailPorCli.set(`${trim(s.COD)}|${trim(s.LOJA)}`, trim(s.EMAIL)));
        } catch (e) { console.warn('[nps-envios] SA1 email:', e.message); }
      }

      const registros = rows.map(r => ({
        id: r.id,
        link: `${BASE()}/pesquisa/${trim(r.token)}`,
        pedido: trim(r.pedido), nf: trim(r.nf),
        clienteCod: trim(r.cliente_cod), clienteLoja: trim(r.cliente_loja),
        clienteNome: trim(r.cliente_nome), empresa: trim(r.empresa), cnpj: trim(r.cnpj),
        telefone: trim(r.telefone), email: emailPorCli.get(`${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`) || '',
        produtoDesc: trim(r.produto_desc), dataFaturamento: trim(r.data_faturamento), valorPedido: N(r.valor_pedido),
        buNome: trim(r.bu_nome), vendedorNome: trim(r.vendedor_nome),
        status: trim(r.status), classificacao: trim(r.classificacao), notaNps: r.nota_nps,
        enviadoEm: r.enviado_em, respondidoEm: r.respondido_em, lembreteEm: r.lembrete_em, expiraEm: r.expira_em,
        emailEnviadoEm: r.email_enviado_em, emailDestino: trim(r.email_destino),
        sacOcorrencias: Array.isArray(r.sac_ocorrencias) ? r.sac_ocorrencias : [], sacVerificadoEm: r.sac_verificado_em,
        motivoErro: r.status === 'ERRO' ? trim(r.envio_resposta?.motivo) : ''
      }));

      if (trim(q.formato).toLowerCase() === 'csv') {
        const head = ['Status', 'Cliente', 'Empresa', 'CPF/CNPJ', 'Pedido', 'NF', 'Produto', 'Faturamento',
          'Telefone', 'E-mail', 'BU', 'Vendedor', 'Enviado em', 'Respondido em', 'E-mail enviado em', 'Destino e-mail',
          'Ocorrência SAC', 'Classificação', 'Nota', 'Motivo erro', 'Link pesquisa'];
        const fmtTs = (t) => t ? new Date(t).toLocaleString('pt-BR') : '';
        const linhas = registros.map(r => [
          r.status, `${r.clienteCod}/${r.clienteLoja} ${r.clienteNome}`.trim(), r.empresa, r.cnpj,
          r.pedido, r.nf, r.produtoDesc, r.dataFaturamento, r.telefone, r.email, r.buNome, r.vendedorNome,
          fmtTs(r.enviadoEm), fmtTs(r.respondidoEm), fmtTs(r.emailEnviadoEm), r.emailDestino,
          (r.sacOcorrencias || []).map(o => `${o.fase}: ${o.titulo}`).join(' | '),
          r.classificacao, r.notaNps ?? '', r.motivoErro, r.link
        ].map(csvCell).join(';'));
        const csv = '﻿' + [head.join(';'), ...linhas].join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="nps-envios-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send(csv);
      }

      const resumo = {
        total: registros.length,
        enviados: registros.filter(r => r.status === 'ENVIADO' || r.status === 'RESPONDIDO').length,
        respondidos: registros.filter(r => r.status === 'RESPONDIDO').length,
        naoRespondidos: registros.filter(r => r.status === 'ENVIADO').length,
        erros: registros.filter(r => r.status === 'ERRO').length,
        emRevisao: registros.filter(r => r.status === 'REVISAO').length
      };
      return res.json({ registros, resumo, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('sac/nps-envios:', err);
      return res.status(500).json({ message: 'Erro ao listar envios: ' + err.message });
    }
  }
});
