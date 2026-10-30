// GET /qualificacao/meta — o que a tela precisa para montar: níveis do usuário, regra
// vigente, criticidades do PRO 5.2, catálogo de documentos, listas dos formulários e
// próximo nº de relatório. Perm 23001+ (qualquer nível do módulo).

const Q = require('../../services/qfCore');
const F = require('../../services/qfFicha');

// PRO 7.3.7 REV OUT261, item 5.2
const CRITICIDADES = [
  { codigo: 'A', nome: 'Crítico A', descricao: 'Componente ou serviço incluído na lista de componentes e serviços críticos.', aplicavel: 'Matérias-primas' },
  { codigo: 'B', nome: 'Crítico B', descricao: 'Dispositivos médicos passíveis de notificação ou registro na ANVISA.', aplicavel: 'Produtos acabados e de revenda' },
  { codigo: 'C', nome: 'Crítico C', descricao: 'Dispositivos médicos que não são passíveis de notificação ou registro na ANVISA.', aplicavel: 'Produtos acabados e de revenda' },
  { codigo: 'D', nome: 'Crítico D', descricao: 'Serviços críticos realizados por terceiros que geram impacto nos produtos fabricados (calibração, laudos radiométricos, processos especiais etc.).', aplicavel: 'Serviços' }
];

module.exports = (app) => ({
  verb: 'get',
  route: '/meta',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const [niveis, regra, tipos, proximo, cfg] = await Promise.all([
        Q.niveisDoUsuario(Pg, req), Q.regraAtiva(Pg), Q.tiposDocumento(Pg), Q.proximoRelInsp(Pg), Q.config(Pg)
      ]);
      const inspetores = await Pg.connectAndQuery(
        `SELECT DISTINCT responsavel_nome FROM tab_qf_inspecao WHERE responsavel_nome IS NOT NULL AND NOT excluido ORDER BY 1`);
      const todosTipos = await Pg.connectAndQuery(`SELECT * FROM tab_qf_tipo_documento ORDER BY ordem, nome`);
      const [itens] = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_item_critico WHERE ativo`);
      return res.json({
        usuario: Q.usuario(req),
        niveis,
        regra,
        criticidades: CRITICIDADES,
        tiposDocumento: tipos,                 // só os ativos (formulários)
        tiposDocumentoTodos: todosTipos,       // inclusive inativos (tela de configuração)
        itensCriticos: itens.n,
        formularios: { tiposEmpresa: F.TIPOS_EMPRESA, tiposFrete: F.TIPOS_FRETE, alteracoes7328: F.ALTERACOES_7328 },
        proximoRelInsp: proximo,
        inspetores: inspetores.map(i => i.responsavel_nome),
        config: { acoesAutomaticas: cfg.acoes_automaticas, emailFornecedor: cfg.email_fornecedor, temEmailsQualidade: cfg.emails_qualidade.length > 0, temEmailsEngenharia: cfg.emails_engenharia.length > 0 }
      });
    } catch (err) { return Q.falha(res, 'carregar os dados do módulo', err); }
  }
});
