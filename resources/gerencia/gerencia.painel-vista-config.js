// GET /gerencia/painel-vista/config — dados da tela de configuração do Painel de
// Gestão à Vista: pipes da org (com flag considerar), universo de responsáveis
// (com setor atual) e a lista de setores. Perm 10004.
//
// Pipes vêm DIRETO do Pipefy (1 request leve) — inclusive os desconsiderados,
// senão não daria pra remarcar um pipe desligado. Usuários vêm do último
// snapshot (quem aparece em card aberto) + os já vinculados no banco.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10004]);
const PipefyPainel = require('../../services/pipefyPainel');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/painel-vista/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    if (!PipefyPainel.disponivel()) {
      return res.status(503).json({ message: 'PIPEFY_TOKEN não configurado no servidor.' });
    }
    try {
      const [pipesOrg, snap, setores, flagsPipe, vinculos] = await Promise.all([
        PipefyPainel.listarPipesOrg(),
        PipefyPainel.obterSnapshot(Pg),
        Pg.connectAndQuery(`SELECT id, nome FROM tab_painel_setor ORDER BY ordem, id`, {}),
        Pg.connectAndQuery(`SELECT pipe_id, considerar FROM tab_painel_pipe`, {}),
        Pg.connectAndQuery(`SELECT usuario_nome, setor_id FROM tab_painel_usuario_setor`, {})
      ]);

      const flag = new Map(flagsPipe.map(f => [trim(f.pipe_id), f.considerar !== false]));
      const pipes = pipesOrg
        .map(p => ({ id: p.id, nome: p.nome, abertos: p.abertosEstimados, considerar: flag.has(p.id) ? flag.get(p.id) : true }))
        .sort((a, b) => b.abertos - a.abertos);

      // Universo de usuários: snapshot (aparecem em card aberto) ∪ já vinculados
      const setorPorNome = new Map(vinculos.map(v => [trim(v.usuario_nome), v.setor_id]));
      const usuarios = new Map();
      (snap.responsaveis || []).forEach(r => usuarios.set(r.nome, {
        nome: r.nome, total: r.total, atrasados: r.atrasados,
        setorId: setorPorNome.get(r.nome) ?? null
      }));
      setorPorNome.forEach((setorId, nome) => {
        if (!usuarios.has(nome)) usuarios.set(nome, { nome, total: 0, atrasados: 0, setorId });
      });

      return res.json({
        setores: setores.map(s => ({ id: s.id, nome: trim(s.nome) })),
        pipes,
        usuarios: [...usuarios.values()].sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome)),
        snapshotDe: snap.geradoEm
      });
    } catch (err) {
      console.error('gerencia/painel-vista-config:', err);
      return res.status(502).json({ message: 'Erro: ' + err.message });
    }
  }
});
