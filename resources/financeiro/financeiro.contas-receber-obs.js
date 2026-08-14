// POST /financeiro/contas-receber/obs — grava/atualiza a observação de um título
// do Contas a Receber. Body: { filial, prefixo, numero, parcela, tipo, obs }.
// obs vazia = REMOVE a observação. Guarda quem/quando (mostrado na tela).
// Postgres (tab_fin_receber_obs, migration 89) — o Protheus é read-only pra nós.
// Perm 8002 (mesma da tela).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8002]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/contas-receber/obs',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const chave = {
      filial: trim(b.filial), prefixo: trim(b.prefixo), numero: trim(b.numero),
      parcela: trim(b.parcela), tipo: trim(b.tipo)
    };
    if (!chave.numero) return res.status(400).json({ message: 'numero é obrigatório.' });
    const obs = trim(b.obs).slice(0, 2000);
    const tituloId = `${chave.filial}|${chave.prefixo}|${chave.numero}|${chave.parcela}|${chave.tipo}`;

    try {
      if (!obs) {
        await Pg.connectAndQuery(`
          DELETE FROM tab_fin_receber_obs
           WHERE filial = @filial AND prefixo = @prefixo AND numero = @numero
             AND parcela = @parcela AND tipo = @tipo`, chave);
        Auditoria.registrar(app, {
          modulo: 'Financeiro', submodulo: 'ContasReceber', acao: 'OBS_REMOVER', severidade: 'INFO', req,
          entidade: 'fin_receber_obs', entidadeId: tituloId,
          descricao: `Removeu a observação do título ${chave.numero}/${chave.parcela}`
        });
        return res.json({ ok: true, removida: true });
      }

      await Pg.connectAndQuery(`
        INSERT INTO tab_fin_receber_obs (filial, prefixo, numero, parcela, tipo, obs, atualizado_por, atualizado_em)
        VALUES (@filial, @prefixo, @numero, @parcela, @tipo, @obs, @por, NOW())
        ON CONFLICT ON CONSTRAINT uq_fin_receber_obs
        DO UPDATE SET obs = EXCLUDED.obs, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
        { ...chave, obs, por: trim(user?.NOME) || trim(user?.EMAIL) || null });

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'ContasReceber', acao: 'OBS_SALVAR', severidade: 'INFO', req,
        entidade: 'fin_receber_obs', entidadeId: tituloId,
        descricao: `Observação no título ${chave.numero}/${chave.parcela}: "${obs.slice(0, 80)}"`,
        meta: { ...chave, obs: obs.slice(0, 500) }
      });
      return res.json({ ok: true, obs, por: trim(user?.NOME) || null, em: new Date().toISOString() });
    } catch (err) {
      console.error('financeiro/contas-receber-obs:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
