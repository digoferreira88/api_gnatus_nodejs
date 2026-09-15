// POST /treinamentos/admin/treinamento — cria/edita treinamento + suas sessões num payload.
// Body: { id?, titulo, descricao, objetivo, instrutor, setorResponsavel, localPadrao, teamsLink,
//         modalidades, permiteCancelamento, permiteTrocaSessao,
//         sessoes: [{ id?, data, horaInicio, horaFim, local, teamsLink, capacidade, _delete? }] }
// Perm 20001. Auditoria com antes/depois.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dataOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(trim(v) || '');

module.exports = (app) => ({
  verb: 'post',
  route: '/admin/treinamento',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const titulo = trim(b.titulo);
    if (!titulo) return res.status(400).json({ message: 'Título é obrigatório.' });
    const modalidades = ['presencial', 'online', 'ambas'].includes(trim(b.modalidades)) ? trim(b.modalidades) : 'ambas';

    const campos = {
      titulo, descricao: trim(b.descricao), objetivo: trim(b.objetivo), instrutor: trim(b.instrutor),
      setor: trim(b.setorResponsavel), local: trim(b.localPadrao), tlink: trim(b.teamsLink), mod: modalidades,
      pc: b.permiteCancelamento !== false, pt: b.permiteTrocaSessao !== false
    };

    try {
      let id = Number(b.id) || 0;
      let acao = 'CRIAR';
      let antes = null;
      if (id) {
        const ex = await Pg.connectAndQuery(`SELECT * FROM tab_treina_treinamento WHERE id=@id`, { id });
        if (!ex.length) return res.status(404).json({ message: 'Treinamento não encontrado.' });
        antes = ex[0]; acao = 'EDITAR';
        await Pg.connectAndQuery(`
          UPDATE tab_treina_treinamento SET
            titulo=@titulo, descricao=@descricao, objetivo=@objetivo, instrutor=@instrutor,
            setor_responsavel=@setor, local_padrao=@local, teams_link=@tlink, modalidades=@mod,
            permite_cancelamento=@pc, permite_troca_sessao=@pt, atualizado_em=NOW()
          WHERE id=@id`, { ...campos, id });
      } else {
        const ins = await Pg.connectAndQuery(`
          INSERT INTO tab_treina_treinamento
            (titulo, descricao, objetivo, instrutor, setor_responsavel, local_padrao, teams_link, modalidades,
             permite_cancelamento, permite_troca_sessao, status, criado_por)
          VALUES (@titulo,@descricao,@objetivo,@instrutor,@setor,@local,@tlink,@mod,@pc,@pt,'rascunho',@uid)
          RETURNING id`, { ...campos, uid: user?.id ? Number(user.id) : null });
        id = ins[0].id;
      }

      // ----- Sessões -----
      const sessoes = Array.isArray(b.sessoes) ? b.sessoes : [];
      const avisos = [];
      for (const s of sessoes) {
        const sid = Number(s.id) || 0;
        if (s._delete && sid) {
          const cnt = await Pg.connectAndQuery(`SELECT COUNT(*) n FROM tab_treina_inscricao WHERE sessao_id=@sid`, { sid });
          if (Number(cnt[0].n) > 0) {
            await Pg.connectAndQuery(`UPDATE tab_treina_sessao SET status='cancelada' WHERE id=@sid AND treinamento_id=@id`, { sid, id });
            avisos.push(`Sessão #${sid} tinha inscrições — foi CANCELADA (não excluída).`);
          } else {
            await Pg.connectAndQuery(`DELETE FROM tab_treina_sessao WHERE id=@sid AND treinamento_id=@id`, { sid, id });
          }
          continue;
        }
        if (!dataOk(s.data)) { avisos.push(`Sessão sem data válida ignorada.`); continue; }
        const cap = Math.max(0, N(s.capacidade));
        const sc = { data: trim(s.data), hi: trim(s.horaInicio), hf: trim(s.horaFim), loc: trim(s.local), tl: trim(s.teamsLink), cap };
        if (sid) {
          const cur = await Pg.connectAndQuery(`SELECT ocupadas FROM tab_treina_sessao WHERE id=@sid AND treinamento_id=@id`, { sid, id });
          if (!cur.length) { avisos.push(`Sessão #${sid} não pertence a este treinamento — ignorada.`); continue; }
          if (cap < Number(cur[0].ocupadas)) { avisos.push(`Sessão de ${sc.data}: capacidade (${cap}) menor que inscritos (${cur[0].ocupadas}) — capacidade NÃO alterada.`); }
          const capFinal = cap < Number(cur[0].ocupadas) ? Number(cur[0].ocupadas) : cap;
          await Pg.connectAndQuery(`
            UPDATE tab_treina_sessao SET data=@data::date, hora_inicio=@hi, hora_fim=@hf, local=@loc, teams_link=@tl, capacidade=@cap
             WHERE id=@sid AND treinamento_id=@id`, { ...sc, cap: capFinal, sid, id });
        } else {
          await Pg.connectAndQuery(`
            INSERT INTO tab_treina_sessao (treinamento_id, data, hora_inicio, hora_fim, local, teams_link, capacidade)
            VALUES (@id,@data::date,@hi,@hf,@loc,@tl,@cap)`, { ...sc, id });
        }
      }

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'Admin', acao, severidade: 'INFO',
        req, entidade: 'treinamento', entidadeId: String(id),
        descricao: `${acao === 'CRIAR' ? 'Criou' : 'Editou'} treinamento "${titulo}" (${sessoes.length} sessão/ões no payload)`,
        meta: antes ? { antes: { titulo: antes.titulo, status: antes.status } } : undefined
      });

      return res.json({ ok: true, id, avisos: avisos.length ? avisos : undefined });
    } catch (err) {
      console.error('treinamentos/admin-salvar:', err.message);
      return res.status(500).json({ message: 'Erro ao salvar: ' + err.message });
    }
  }
});
