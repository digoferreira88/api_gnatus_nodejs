// POST /ciosp/equipe — inclui ou altera um membro da equipe do evento (uma linha por
// usuário e edição). É daqui que o pedido herda categoria, gerente e equipe para o
// painel, e é aqui que o app sabe qual gerente aprova o desconto. Perm 19004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'post',
  route: '/equipe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const b = req.body || {};
    const edicao = String(b.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    const { erro, membro: m } = Edicao.validarMembro(b);
    if (erro) return res.status(400).json({ message: erro });

    try {
      const [usuario] = await Edicao.q(app, `SELECT id FROM tab_intranet_usr WHERE id = $1 AND ativo`, [m.usuario_id]);
      if (!usuario) return res.status(400).json({ message: 'Usuário não encontrado ou inativo na intranet.' });

      if (m.gerente_id) {
        const [g] = await Edicao.q(app,
          `SELECT 1 FROM tab_ciosp_equipe WHERE edicao = $1 AND usuario_id = $2 AND papel = 'gerente' AND ativo`,
          [edicao, m.gerente_id]);
        if (!g) return res.status(400).json({ message: 'O gerente escolhido não está cadastrado como gerente nesta edição.' });
      }

      // Rebaixar a vendedor quem ainda é gerente de alguém deixaria esses vendedores sem aprovador.
      if (m.papel === 'vendedor') {
        const liderados = await Edicao.q(app,
          `SELECT nome_exibicao FROM tab_ciosp_equipe WHERE edicao = $1 AND gerente_id = $2 AND ativo`,
          [edicao, m.usuario_id]);
        if (liderados.length) {
          return res.status(409).json({
            message: `Ainda é gerente de: ${liderados.map(l => l.nome_exibicao).join(', ')}. Troque o gerente deles antes.`
          });
        }
      }

      const [row] = await Edicao.q(app,
        `INSERT INTO tab_ciosp_equipe (edicao, usuario_id, nome_exibicao, papel, gerente_id, categoria, equipe, ativo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (edicao, usuario_id) DO UPDATE SET nome_exibicao=$3, papel=$4, gerente_id=$5,
           categoria=$6, equipe=$7, ativo=$8, atualizado_em=NOW()
         RETURNING id`,
        [edicao, m.usuario_id, m.nome_exibicao, m.papel, m.gerente_id, m.categoria, m.equipe, m.ativo]);
      await Edicao.tocarVersao(app, edicao);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Equipe do evento', acao: 'SALVAR', severidade: 'INFO',
        req, entidade: 'equipe', entidadeId: row.id,
        descricao: `${edicao}: ${m.nome_exibicao} (${m.papel}${m.categoria ? ', ' + m.categoria : ''})`
      });
      return res.json({ ok: true, id: row.id });
    } catch (err) {
      console.error('ciosp/equipe (salvar):', err.message);
      return res.status(500).json({ message: 'Erro ao salvar o membro da equipe: ' + err.message });
    }
  }
});
