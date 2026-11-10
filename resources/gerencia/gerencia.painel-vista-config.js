// GET /gerencia/painel-vista/config — dados da tela de configuração do Painel de
// Gestão à Vista: pipes da org (com flag considerar), universo de responsáveis
// (com setor atual) e a lista de setores. Perm 10004.
//
// Pipes vêm do espelho do Pipefy no banco (a leitura agendada grava TODOS os
// pipes da org, inclusive os desconsiderados — senão não daria pra remarcar um
// pipe desligado). Zero chamada ao Pipefy. Usuários vêm do último snapshot (quem
// aparece em card aberto) + os já vinculados no banco.
//
// Setor × Gerente (migration 146): os gerentes vêm da database GESTORES do
// Pipefy (espelho tab_painel_gestor, relido nas leituras agendadas). Espelho
// vazio = 1ª vez: lê a database agora (1 chamada). Sem a tabela (migration não
// aplicada) a tela segue funcionando e só o quadro de gerentes avisa.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10004]);
const PipefyPainel = require('../../services/pipefyPainel');
const trim = (v) => String(v == null ? '' : v).trim();

async function lerGerentes(Pg) {
  const consultar = () => Promise.all([
    Pg.connectAndQuery(`SELECT record_id, nome, email, whatsapp, no_pipefy, lido_em FROM tab_painel_gestor ORDER BY nome`, {}),
    Pg.connectAndQuery(`SELECT setor_id, gestor_id FROM tab_painel_setor_gestor`, {})
  ]);
  try {
    let [gestores, vinculos] = await consultar();
    let erro = null;
    if (!gestores.length && PipefyPainel.disponivel()) {
      try {
        await PipefyPainel.lerGestoresAgora(Pg);
        [gestores, vinculos] = await consultar();
      } catch (e) { erro = e.message; }
    }
    const lidoEm = gestores.reduce((m, g) => (g.no_pipefy && (!m || g.lido_em > m) ? g.lido_em : m), null);
    return {
      disponivel: true, erro,
      lidoEm: lidoEm ? new Date(lidoEm).toISOString() : null,
      gestores: gestores.map(g => ({
        id: trim(g.record_id), nome: trim(g.nome), email: trim(g.email), whatsapp: trim(g.whatsapp), ativo: g.no_pipefy !== false
      })),
      gerentes: vinculos.map(v => ({ setorId: v.setor_id, gestorId: trim(v.gestor_id) }))
    };
  } catch (err) {
    if (err && err.code === '42P01') return { disponivel: false, erro: null, lidoEm: null, gestores: [], gerentes: [] };   // migration 146 não aplicada
    throw err;
  }
}

module.exports = (app) => ({
  verb: 'get',
  route: '/painel-vista/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      // snapshot primeiro: no 1º acesso depois do deploy ele enche o espelho
      const snap = await PipefyPainel.obterSnapshot(Pg);
      const [pipesOrg, setores, flagsPipe, vinculos, ger] = await Promise.all([
        PipefyPainel.listarPipesEspelho(Pg),
        Pg.connectAndQuery(`SELECT id, nome FROM tab_painel_setor ORDER BY ordem, id`, {}),
        Pg.connectAndQuery(`SELECT pipe_id, considerar FROM tab_painel_pipe`, {}),
        Pg.connectAndQuery(`SELECT usuario_nome, setor_id FROM tab_painel_usuario_setor`, {}),
        lerGerentes(Pg)
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
        gestores: ger.gestores,
        gerentes: ger.gerentes,
        gerentesDisponivel: ger.disponivel,
        gestoresLidoEm: ger.lidoEm,
        gestoresErro: ger.erro,
        snapshotDe: snap.geradoEm
      });
    } catch (err) {
      console.error('gerencia/painel-vista-config:', err);
      return res.status(502).json({ message: 'Erro: ' + err.message });
    }
  }
});
