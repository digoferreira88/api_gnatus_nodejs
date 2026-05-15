// Atualiza dados de uma etapa de um registro.
// PATCH /producao/registro/:id/etapa/:codigo
// Body: { status?, responsavelId?, dataExecucao?, observacao?, rncNumero?, dadosExtras?, avancarFase? }
//
// Se avancarFase=true e status=aprovado e for a etapa atual, avanca a fase_atual do registro.
// Se for a ultima etapa (12), marca status=concluido.

const { sanitizarDadosExtras } = require('./_etapas');
const trim = (v) => v == null ? null : String(v).trim();

const checarPerm = async (Pg, idUser, perm) => {
  const r = await Pg.connectAndQuery(
    `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao IN (0, @perm)`,
    { id: idUser, perm }
  );
  return r.length > 0;
};

module.exports = (app) => ({
  verb: 'patch',
  route: '/registro/:id/etapa/:codigo',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await checarPerm(Pg, user.ID, 14001))) {
      return res.status(403).json({ message: 'Sem permissao (14001).' });
    }

    const id = Number(req.params.id);
    const codigo = Number(req.params.codigo);
    if (!Number.isInteger(id) || !Number.isInteger(codigo) || codigo < 1 || codigo > 12) {
      return res.status(400).json({ message: 'ID/codigo invalido.' });
    }

    const reg = await Pg.connectAndQuery(`SELECT id, fase_atual, status FROM tab_prod_registro WHERE id = @id`, { id });
    if (!reg.length) return res.status(404).json({ message: 'Registro nao encontrado.' });
    if (reg[0].status === 'concluido') return res.status(409).json({ message: 'Registro ja concluido.' });

    // Snapshot do estado atual da etapa pra detectar mudanca de status (gestao)
    const etapaAtual = await Pg.connectAndQuery(
      `SELECT id, status, responsavel_id FROM tab_prod_registro_etapa WHERE registro_id = @id AND etapa_codigo = @cod`,
      { id, cod: codigo }
    );
    const statusAntes = etapaAtual[0]?.status || null;
    const etapaPgId = etapaAtual[0]?.id || null;

    const updates = [];
    const params = { id, cod: codigo };

    if ('status' in req.body) {
      const s = trim(req.body.status);
      if (!['pendente', 'em_andamento', 'aprovado', 'reprovado'].includes(s)) {
        return res.status(400).json({ message: 'status invalido.' });
      }
      updates.push('status = @status'); params.status = s;
    }
    if ('responsavelId' in req.body) {
      const rid = req.body.responsavelId == null ? null : Number(req.body.responsavelId);
      updates.push('responsavel_id = @rid'); params.rid = rid;
      // Snapshot do nome
      if (rid) {
        const u = await Pg.connectAndQuery(`SELECT nome FROM tab_intranet_usr WHERE id = @rid`, { rid });
        params.rnome = u[0]?.nome || null;
        updates.push('responsavel_nome = @rnome');
      } else {
        updates.push('responsavel_nome = NULL');
      }
    }
    if ('dataExecucao' in req.body) {
      updates.push('data_execucao = @dexec'); params.dexec = req.body.dataExecucao || null;
    }
    if ('observacao' in req.body) {
      updates.push('observacao = @obs'); params.obs = trim(req.body.observacao);
    }
    if ('rncNumero' in req.body) {
      updates.push('rnc_numero = @rnc'); params.rnc = trim(req.body.rncNumero);
    }
    if ('dadosExtras' in req.body) {
      const extras = sanitizarDadosExtras(codigo, req.body.dadosExtras || {});
      updates.push(`dados_extras = @extras::jsonb`); params.extras = JSON.stringify(extras);
    }

    if (!updates.length) return res.status(400).json({ message: 'Nenhum campo pra atualizar.' });

    updates.push('atualizado_em = NOW()');

    try {
      await Pg.connectAndQuery(`
        UPDATE tab_prod_registro_etapa
           SET ${updates.join(', ')}
         WHERE registro_id = @id AND etapa_codigo = @cod`, params);

      // Log de transicao de status (gestao). Grava se: status mudou OU eh
      // o primeiro registro de status (status_de = NULL). Permite calcular
      // tempo entre transicoes (em_andamento -> aprovado etc).
      if (etapaPgId && 'status' in req.body && params.status !== statusAntes) {
        const respFinal = 'rid' in params ? params.rid : (etapaAtual[0]?.responsavel_id || null);
        await Pg.connectAndQuery(`
          INSERT INTO tab_prod_registro_etapa_log
            (registro_etapa_id, registro_id, etapa_codigo, status_de, status_para, responsavel_id, mudou_por)
          VALUES (@eid, @id, @cod, @sde, @spara, @rid, @mp)`,
          { eid: etapaPgId, id, cod: codigo, sde: statusAntes, spara: params.status, rid: respFinal, mp: user.ID }
        );
      }

      // Avancar fase: se status=aprovado e for fase atual, avanca pra proxima
      const avancar = req.body.avancarFase === true;
      if (avancar && params.status === 'aprovado' && codigo === reg[0].fase_atual) {
        const proxima = codigo + 1;
        if (codigo === 12) {
          // Ultima etapa concluida -> registro concluido
          await Pg.connectAndQuery(
            `UPDATE tab_prod_registro SET status = 'concluido', atualizado_em = NOW() WHERE id = @id`,
            { id }
          );
        } else {
          await Pg.connectAndQuery(
            `UPDATE tab_prod_registro SET fase_atual = @prox, atualizado_em = NOW() WHERE id = @id`,
            { id, prox: proxima }
          );
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro producao/etapa PATCH:', err);
      return res.status(500).json({ message: 'Erro ao atualizar etapa: ' + err.message });
    }
  }
});
