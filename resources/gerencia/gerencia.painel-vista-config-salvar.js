// POST /gerencia/painel-vista/config/pipe    — { pipeId, nome, considerar }
// POST /gerencia/painel-vista/config/usuario — { nome, setorId|null }
// POST /gerencia/painel-vista/config/gerente — { setorId, gestorId, vincular }
// POST /gerencia/painel-vista/config/ler-gestores — relê a database GESTORES do Pipefy
// Salvam a config do Painel de Gestão à Vista e derrubam o cache do snapshot
// (o painel reflete no próximo refresh; pipe marcado é lido do Pipefy na hora).
// Gerente não mexe no snapshot (só alimenta o aviso de atrasos), então não
// invalida o cache. gestorId = id do registro na database GESTORES (migration 146).
// Perm 10004. Auditado.
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
        const gestorId = trim(b.gestorId).slice(0, 20);
        const vincular = b.vincular !== false;
        if (!Number.isInteger(setorId) || !gestorId) return res.status(400).json({ message: 'setorId e gestorId são obrigatórios.' });

        try {
          const [s, g] = await Promise.all([
            Pg.connectAndQuery(`SELECT nome FROM tab_painel_setor WHERE id = @id`, { id: setorId }),
            Pg.connectAndQuery(`SELECT nome, no_pipefy FROM tab_painel_gestor WHERE record_id = @id`, { id: gestorId })
          ]);
          if (!s.length) return res.status(404).json({ message: 'Setor não encontrado.' });
          if (!g.length) return res.status(404).json({ message: 'Gestor não encontrado na database GESTORES.' });
          const setorNome = trim(s[0].nome);
          const gerNome = trim(g[0].nome);

          if (vincular) {
            if (g[0].no_pipefy === false) return res.status(400).json({ message: 'Gestor não está mais na database GESTORES do Pipefy.' });
            await Pg.connectAndQuery(`
              INSERT INTO tab_painel_setor_gestor (setor_id, gestor_id, criado_por, criado_em)
              VALUES (@setor, @ges, @por, NOW())
              ON CONFLICT (setor_id, gestor_id) DO NOTHING`,
              { setor: setorId, ges: gestorId, por });
          } else {
            await Pg.connectAndQuery(`DELETE FROM tab_painel_setor_gestor WHERE setor_id = @setor AND gestor_id = @ges`,
              { setor: setorId, ges: gestorId });
          }
          Auditoria.registrar(app, {
            modulo: 'Gerencia', submodulo: 'PainelVista', acao: 'SETOR_GERENTE', severidade: 'INFO', req,
            entidade: 'painel_setor_gestor', entidadeId: `${setorId}:${gestorId}`,
            descricao: vincular ? `Vinculou "${gerNome}" como gerente do setor ${setorNome}` : `Removeu "${gerNome}" da gerência do setor ${setorNome}`
          });
          return res.json({ ok: true });
        } catch (err) {
          if (err && err.code === '42P01') return res.status(503).json({ message: 'Tabela de gestores ainda não criada (migration 146).' });
          throw err;
        }
      }

      if (alvo === 'ler-gestores') {
        if (!PipefyPainel.disponivel()) return res.status(503).json({ message: 'PIPEFY_TOKEN não configurado no servidor.' });
        try {
          const r = await PipefyPainel.lerGestoresAgora(Pg);
          return res.json({ ok: true, gestores: r.gestores });
        } catch (err) {
          if (err && err.code === '42P01') return res.status(503).json({ message: 'Tabela de gestores ainda não criada (migration 146).' });
          return res.status(502).json({ message: 'Falha ao ler a database GESTORES: ' + err.message });
        }
      }

      return res.status(400).json({ message: 'Alvo deve ser pipe, usuario, gerente ou ler-gestores.' });
    } catch (err) {
      console.error('gerencia/painel-vista-config-salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
