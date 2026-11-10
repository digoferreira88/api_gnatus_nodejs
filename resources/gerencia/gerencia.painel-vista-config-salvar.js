// POST /gerencia/painel-vista/config/pipe    — { pipeId, nome, considerar }
// POST /gerencia/painel-vista/config/usuario — { nome, setorId|null }
// POST /gerencia/painel-vista/config/gerente — { setorId, idUser, vincular }
// Salvam a config do Painel de Gestão à Vista e derrubam o cache do snapshot
// (o painel reflete no próximo refresh; pipe marcado é lido do Pipefy na hora).
// Gerente não mexe no snapshot (só alimenta o aviso de atrasos), então não
// invalida o cache. Perm 10004. Auditado.
// (Dois endpoints num arquivo só via rota com :alvo — mesmo padrão de upsert.)

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10004]);
const Auditoria = require('../../services/auditoria');
const PipefyPainel = require('../../services/pipefyPainel');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/painel-vista/config/:alvo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const por = trim(user?.NOME) || null;
    const alvo = trim(req.params.alvo);
    const b = req.body || {};

    try {
      if (alvo === 'pipe') {
        const pipeId = trim(b.pipeId);
        const nome = trim(b.nome).slice(0, 120);
        const considerar = b.considerar !== false;
        if (!pipeId) return res.status(400).json({ message: 'pipeId é obrigatório.' });
        await Pg.connectAndQuery(`
          INSERT INTO tab_painel_pipe (pipe_id, nome, considerar, atualizado_por, atualizado_em)
          VALUES (@id, @nome, @cons, @por, NOW())
          ON CONFLICT (pipe_id)
          DO UPDATE SET nome = EXCLUDED.nome, considerar = EXCLUDED.considerar,
                        atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
          { id: pipeId, nome, cons: considerar, por });
        Auditoria.registrar(app, {
          modulo: 'Gerencia', submodulo: 'PainelVista', acao: 'PIPE_FLAG', severidade: 'INFO', req,
          entidade: 'painel_pipe', entidadeId: pipeId,
          descricao: `Pipe "${nome || pipeId}" ${considerar ? 'INCLUÍDO no' : 'REMOVIDO do'} painel`
        });
        PipefyPainel.invalidarCache();
        // Desmarcar vale na hora (filtro na leitura do espelho). Marcar lê só este
        // pipe no Pipefy em segundo plano, sem esperar a próxima leitura agendada.
        if (considerar && PipefyPainel.disponivel()) {
          PipefyPainel.lerPipeAgora(Pg, pipeId, nome).catch(e =>
            console.warn(`[painel-vista-config] leitura do pipe ${pipeId} falhou:`, e.message));
        }
        return res.json({ ok: true });
      }

      if (alvo === 'usuario') {
        const nome = trim(b.nome).slice(0, 120);
        const setorId = b.setorId == null || b.setorId === '' ? null : Number(b.setorId);
        if (!nome) return res.status(400).json({ message: 'nome é obrigatório.' });
        if (setorId != null && !Number.isInteger(setorId)) return res.status(400).json({ message: 'setorId inválido.' });

        if (setorId == null) {
          await Pg.connectAndQuery(`DELETE FROM tab_painel_usuario_setor WHERE usuario_nome = @nome`, { nome });
        } else {
          const s = await Pg.connectAndQuery(`SELECT nome FROM tab_painel_setor WHERE id = @id`, { id: setorId });
          if (!s.length) return res.status(404).json({ message: 'Setor não encontrado.' });
          await Pg.connectAndQuery(`
            INSERT INTO tab_painel_usuario_setor (usuario_nome, setor_id, atualizado_por, atualizado_em)
            VALUES (@nome, @setor, @por, NOW())
            ON CONFLICT (usuario_nome)
            DO UPDATE SET setor_id = EXCLUDED.setor_id, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
            { nome, setor: setorId, por });
        }
        Auditoria.registrar(app, {
          modulo: 'Gerencia', submodulo: 'PainelVista', acao: 'USUARIO_SETOR', severidade: 'INFO', req,
          entidade: 'painel_usuario', entidadeId: nome,
          descricao: setorId == null ? `Removeu o setor de "${nome}"` : `Vinculou "${nome}" ao setor id ${setorId}`
        });
        PipefyPainel.invalidarCache();
        return res.json({ ok: true });
      }

      if (alvo === 'gerente') {
        const setorId = Number(b.setorId);
        const idUser = Number(b.idUser);
        const vincular = b.vincular !== false;
        if (!Number.isInteger(setorId) || !Number.isInteger(idUser)) return res.status(400).json({ message: 'setorId e idUser são obrigatórios.' });

        const [s, u] = await Promise.all([
          Pg.connectAndQuery(`SELECT nome FROM tab_painel_setor WHERE id = @id`, { id: setorId }),
          Pg.connectAndQuery(`SELECT nome, ativo FROM tab_intranet_usr WHERE id = @id`, { id: idUser })
        ]);
        if (!s.length) return res.status(404).json({ message: 'Setor não encontrado.' });
        if (!u.length) return res.status(404).json({ message: 'Usuário não encontrado.' });
        const setorNome = trim(s[0].nome);
        const gerNome = trim(u[0].nome);

        try {
          if (vincular) {
            if (u[0].ativo === false) return res.status(400).json({ message: 'Usuário inativo na intranet.' });
            await Pg.connectAndQuery(`
              INSERT INTO tab_painel_setor_gerente (setor_id, id_user, criado_por, criado_em)
              VALUES (@setor, @usr, @por, NOW())
              ON CONFLICT (setor_id, id_user) DO NOTHING`,
              { setor: setorId, usr: idUser, por });
          } else {
            await Pg.connectAndQuery(`DELETE FROM tab_painel_setor_gerente WHERE setor_id = @setor AND id_user = @usr`,
              { setor: setorId, usr: idUser });
          }
        } catch (err) {
          if (err && err.code === '42P01') return res.status(503).json({ message: 'Tabela de gerentes ainda não criada (migration 145).' });
          throw err;
        }
        Auditoria.registrar(app, {
          modulo: 'Gerencia', submodulo: 'PainelVista', acao: 'SETOR_GERENTE', severidade: 'INFO', req,
          entidade: 'painel_setor_gerente', entidadeId: `${setorId}:${idUser}`,
          descricao: vincular ? `Vinculou "${gerNome}" como gerente do setor ${setorNome}` : `Removeu "${gerNome}" da gerência do setor ${setorNome}`
        });
        return res.json({ ok: true });
      }

      return res.status(400).json({ message: 'Alvo deve ser pipe, usuario ou gerente.' });
    } catch (err) {
      console.error('gerencia/painel-vista-config-salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
