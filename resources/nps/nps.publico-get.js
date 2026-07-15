// GET /nps/publico/:token  (ANÔNIMO)
// Página pública da pesquisa: valida o token e devolve as perguntas ativas +
// a mensagem de abertura. Não expõe dados sensíveis do cliente (só 1º nome).

const NPS = require('../../services/npsPosvenda');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/publico/:token',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = trim(req.params.token);
    if (!token || token.length < 10) return res.status(400).json({ message: 'Link inválido.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT id, cliente_nome, pedido, status, respondido_em, expira_em
          FROM tab_nps_convite WHERE token = @t`, { t: token });
      if (!rows.length) return res.status(404).json({ estado: 'INVALIDO', message: 'Pesquisa não encontrada.' });
      const c = rows[0];

      if (trim(c.status) === 'RESPONDIDO') return res.json({ estado: 'RESPONDIDO' });
      if (c.expira_em && new Date(c.expira_em) < new Date()) return res.json({ estado: 'EXPIRADO' });

      const cfg = await NPS.lerConfig(Pg);
      const perguntas = await Pg.connectAndQuery(`
        SELECT id, ordem, texto, tipo, opcoes, obrigatoria, e_nps
          FROM tab_nps_pergunta WHERE ativa = TRUE ORDER BY ordem, id`, {});

      const primeiroNome = trim(c.cliente_nome).split(/\s+/)[0] || '';
      return res.json({
        estado: 'ABERTO',
        cliente: primeiroNome,
        pedido: trim(c.pedido),
        mensagem: cfg.mensagem || {},
        perguntas: perguntas.map(p => ({
          id: p.id, ordem: p.ordem, texto: trim(p.texto), tipo: trim(p.tipo),
          opcoes: Array.isArray(p.opcoes) ? p.opcoes : [], obrigatoria: p.obrigatoria, eNps: p.e_nps
        }))
      });
    } catch (err) {
      console.error('nps/publico-get:', err);
      return res.status(500).json({ message: 'Erro ao carregar a pesquisa.' });
    }
  }
});
