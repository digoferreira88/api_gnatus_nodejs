// POST /sac/nps/config
// Body: { detratorMax, promotorMin, ativo, dataInicio, expiraDias, mensagem:{titulo,subtitulo,agradecimento} }
// Salva a configuração (thresholds/liga-desliga/mensagens). Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/nps/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    const detratorMax = Math.min(10, Math.max(0, Math.trunc(N(b.detratorMax))));
    const promotorMin = Math.min(10, Math.max(0, Math.trunc(N(b.promotorMin))));
    if (promotorMin <= detratorMax) return res.status(400).json({ message: 'A nota de promotor deve ser maior que a de detrator.' });

    const set = async (chave, valor) => Pg.connectAndQuery(
      `INSERT INTO tab_nps_config (chave, valor, atualizado_em, atualizado_por)
       VALUES (@c, @v::jsonb, NOW(), @u)
       ON CONFLICT (chave) DO UPDATE SET valor = @v::jsonb, atualizado_em = NOW(), atualizado_por = @u`,
      { c: chave, v: JSON.stringify(valor), u: user?.ID || null });

    try {
      await set('classificacao', { detratorMax, promotorMin });
      await set('ativo', b.ativo === true || b.ativo === 'true');
      await set('dataInicio', trim(b.dataInicio) || null);
      await set('expiraDias', Math.max(1, Math.trunc(N(b.expiraDias) || 30)));
      await set('mensagem', {
        titulo: trim(b.mensagem?.titulo).slice(0, 200),
        subtitulo: trim(b.mensagem?.subtitulo).slice(0, 300),
        agradecimento: trim(b.mensagem?.agradecimento).slice(0, 300)
      });

      Auditoria.registrar(app, {
        modulo: 'SAC', submodulo: 'NPS', acao: 'CONFIG', severidade: 'INFO', req,
        entidade: 'nps_config', entidadeId: 'config',
        descricao: `Configurou NPS: detrator≤${detratorMax}, promotor≥${promotorMin}, ativo=${b.ativo === true || b.ativo === 'true'}`,
        meta: { detratorMax, promotorMin, ativo: b.ativo }
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('sac/nps-config-salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
