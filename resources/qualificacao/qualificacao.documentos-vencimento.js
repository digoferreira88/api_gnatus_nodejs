// GET /qualificacao/documentos/vencimentos?dias=90 — painel de controle de documentos:
// todos os documentos exigidos dos fornecedores críticos que estão VENCIDOS (inclusive
// protocolo com prazo de regularização vencido), vencendo/prazo do protocolo em até `dias`,
// ou PENDENTES (obrigatório nunca enviado). Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/documentos/vencimentos',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 90));
    try {
      const situacao = await Q.situacaoDocsCriticos(Pg);
      const linhas = [];
      for (const s of situacao.values()) {
        for (const i of s.itens) {
          const vencido = ['VENCIDO', 'PROTOCOLO_VENCIDO'].includes(i.situacao);
          const pendente = i.situacao === 'PENDENTE' && i.regra === 'OBRIGATORIO';
          const vencendo = i.venceEm != null && i.venceEm <= dias && ['OK', 'VENCENDO', 'PROTOCOLADO'].includes(i.situacao);
          if (!vencido && !pendente && !vencendo) continue;
          linhas.push({
            fornecedorId: s.fornecedor.id, codigo: s.fornecedor.codigo, razaoSocial: s.fornecedor.razao_social,
            criticidades: s.fornecedor.criticidades || [], statusFornecedor: s.fornecedor.status_qualificacao, suspensaoTipo: s.fornecedor.suspensao_tipo, contatoEmail: s.fornecedor.contato_email,
            tipoId: i.tipoId, tipoCodigo: i.codigo, tipoNome: i.nome, regra: i.regra,
            situacao: vencido ? 'VENCIDO' : pendente ? 'PENDENTE' : 'VENCENDO', situacaoDocumento: i.situacao,
            protocolo: !!(i.documento && i.documento.status === 'PROTOCOLADO'), prazoRegularizacao: i.documento ? i.documento.prazo_regularizacao : null,
            venceEm: i.venceEm, dataValidade: i.documento ? i.documento.data_validade : null,
            documentoId: i.documento ? i.documento.id : null, numero: i.documento ? i.documento.numero : null
          });
        }
      }
      const ordem = { VENCIDO: 0, VENCENDO: 1, PENDENTE: 2 };
      linhas.sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || (a.venceEm ?? 9999) - (b.venceEm ?? 9999) || a.codigo.localeCompare(b.codigo));
      const faixa = (d) => linhas.filter(l => l.situacao === 'VENCENDO' && l.venceEm <= d).length;
      return res.json({
        dias, linhas,
        resumo: { vencidos: linhas.filter(l => l.situacao === 'VENCIDO').length, pendentes: linhas.filter(l => l.situacao === 'PENDENTE').length,
          em30: faixa(30), em60: faixa(60), em90: faixa(90), fornecedoresCriticos: situacao.size }
      });
    } catch (err) { return Q.falha(res, 'carregar os vencimentos', err); }
  }
});
