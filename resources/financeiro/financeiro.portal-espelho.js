// POST /financeiro/portal-espelho — gera o espelho do portal do cliente e publica.
// (a consulta fica em financeiro.portal-espelho-consulta.js: o loader lê uma rota por arquivo)
//
// Perm 8005 (mesma do envio de boleto: quem cuida de boleto cuida disto).
//
// O portal do cliente não vive na intranet; este endpoint é o lado de cá, que
// monta o que ele pode mostrar e empurra. Sem PORTAL_URL/PORTAL_TOKEN no .env o
// espelho é gerado e fica guardado, mas nada sai (status `inerte`) — dá para
// conferir o conteúdo antes de existir portal nenhum.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005, 0]);
const Auditoria = require('../../services/auditoria');
const Espelho = require('../../services/portalEspelho');

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');

module.exports = (app) => ({
  verb: 'post',
  route: '/portal-espelho',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    try {
      const r = await Espelho.rodar(app, { por: user?.id ? Number(user.id) : null });

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'Portal do cliente', acao: 'PUBLICAR',
        severidade: r.erro ? 'ALERTA' : 'INFO', req, entidade: 'espelho',
        descricao: `Espelho do portal: ${r.titulos} títulos de ${r.clientes} clientes · `
          + `${r.com_2via} com 2ª via · ${r.status}${r.erro ? ' — ' + r.erro : ''}`
      });

      if (r.erro) return res.status(502).json({ message: 'Erro ao publicar: ' + r.erro, ...r });
      return res.json({
        ok: true, ...r,
        aviso: r.status === 'inerte'
          ? 'Espelho gerado e guardado, mas NÃO enviado: falta PORTAL_URL/PORTAL_TOKEN no .env.'
          : null
      });
    } catch (err) {
      console.error('financeiro/portal-espelho:', err.message);
      return res.status(500).json({ message: 'Erro ao gerar o espelho: ' + err.message });
    }
  }
});
