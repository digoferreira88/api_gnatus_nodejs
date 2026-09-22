// PUT /cobranca/comissao/config — salva colaborador cobrador + faixas + BUs
// excluídas (substitui as listas por completo). Perm 9006 (gestão).
const trim = (v) => String(v == null ? '' : v).trim();
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9006, 0]);

module.exports = (app) => ({
  verb: 'put',
  route: '/comissao/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const b = req.body || {};
    const colaboradorId = Number(b.colaboradorId) || null;

    // Valida faixas
    const faixas = Array.isArray(b.faixas) ? b.faixas : [];
    const faixasLimpas = [];
    for (const f of faixas) {
      const dMin = Math.trunc(Number(f.diasMin));
      const dMax = (f.diasMax === null || f.diasMax === '' || f.diasMax === undefined) ? null : Math.trunc(Number(f.diasMax));
      const pct = Number(f.pct);
      if (!Number.isFinite(dMin) || dMin < 0) return res.status(400).json({ message: 'Faixa com dias inicial inválido.' });
      if (dMax !== null && (!Number.isFinite(dMax) || dMax < dMin)) return res.status(400).json({ message: 'Faixa com dias final menor que o inicial.' });
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: 'Percentual de faixa inválido (0 a 100).' });
      faixasLimpas.push({ dMin, dMax, pct });
    }
    // Ordena por dias_min e checa sobreposição
    faixasLimpas.sort((a, b2) => a.dMin - b2.dMin);
    for (let i = 1; i < faixasLimpas.length; i++) {
      const ant = faixasLimpas[i - 1], cur = faixasLimpas[i];
      const antMax = ant.dMax == null ? Infinity : ant.dMax;
      if (cur.dMin <= antMax) return res.status(400).json({ message: 'Faixas de atraso se sobrepõem — ajuste os intervalos.' });
    }

    const bus = Array.isArray(b.busExcluidas) ? b.busExcluidas : [];
    const busLimpas = [];
    const vistos = new Set();
    for (const x of bus) {
      const codigo = trim(x.codigo);
      if (!codigo || vistos.has(codigo)) continue;
      vistos.add(codigo);
      busLimpas.push({ codigo, label: trim(x.label) });
    }

    try {
      await Pg.connectAndQuery(
        `UPDATE tab_cobranca_comissao_config
            SET colaborador_id = @cid, atualizado_em = NOW(), id_user = @uid WHERE id = 1`,
        { cid: colaboradorId, uid: user.ID });

      await Pg.connectAndQuery(`DELETE FROM tab_cobranca_comissao_faixa`, {});
      for (let i = 0; i < faixasLimpas.length; i++) {
        const f = faixasLimpas[i];
        await Pg.connectAndQuery(
          `INSERT INTO tab_cobranca_comissao_faixa (dias_min, dias_max, pct, ordem, ativo)
           VALUES (@min, @max, @pct, @ordem, TRUE)`,
          { min: f.dMin, max: f.dMax, pct: f.pct, ordem: i });
      }

      await Pg.connectAndQuery(`DELETE FROM tab_cobranca_comissao_bu_excluida`, {});
      for (const x of busLimpas) {
        await Pg.connectAndQuery(
          `INSERT INTO tab_cobranca_comissao_bu_excluida (bu_codigo, bu_label, id_user)
           VALUES (@cod, @label, @uid)`,
          { cod: x.codigo, label: x.label || null, uid: user.ID });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('cobranca/comissao-config-salvar:', err);
      return res.status(500).json({ message: 'Erro ao salvar config: ' + err.message });
    }
  }
});
