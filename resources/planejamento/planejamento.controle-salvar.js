// POST /planejamento/controle
// Adiciona/atualiza um pedido no controle (atribui responsável, muda status,
// edita obs/categoria/NF). Snapshot de valor/BU vem do Protheus no 1º add.
// Permissão 3003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3003]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/controle',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const pedido = trim(b.pedido);
    if (!pedido) return res.status(400).json({ message: 'pedido é obrigatório.' });

    const responsavelId = b.responsavelId != null && b.responsavelId !== '' ? N(b.responsavelId) : null;
    const status = trim(b.status);
    const categoria = trim(b.categoria);
    const nf = trim(b.nf);
    const obs = String(b.obs || '');

    try {
      // Estado anterior (p/ histórico de status)
      const prev = (await Pg.connectAndQuery(
        `SELECT status FROM tab_plan_controle WHERE filial='01' AND pedido=@ped`, { ped: pedido }))[0];
      const novo = !prev;

      // Nome do responsável (snapshot)
      let responsavelNome = null;
      if (responsavelId) {
        const u = (await Pg.connectAndQuery(`SELECT nome FROM tab_intranet_usr WHERE id=@id`, { id: responsavelId }))[0];
        responsavelNome = trim(u?.nome) || `id ${responsavelId}`;
      }

      // No 1º add, captura valor + BU do Protheus
      let valor = null, bu = trim(b.tipoBu);
      if (novo) {
        const p = (await Protheus.connectAndQuery(
          `SELECT RTRIM(sc5.C5_ZTIPO) bu, CAST(ISNULL(tp.total,0) AS NUMERIC(14,2)) total
             FROM SC5010 sc5 WITH (NOLOCK)
             LEFT JOIN total_pedido_sc6 tp WITH (NOLOCK) ON tp.c6_num = sc5.C5_NUM
            WHERE sc5.C5_FILIAL='01' AND sc5.C5_NUM=@ped AND sc5.D_E_L_E_T_<>'*'`, { ped: pedido }))[0];
        if (!p) return res.status(404).json({ message: `Pedido ${pedido} não encontrado no Protheus.` });
        valor = N(p.total); if (!bu) bu = trim(p.bu);
      }

      const statusFinal = status || (novo ? 'AGUARDANDO FATURAMENTO' : null);

      await Pg.connectAndQuery(`
        INSERT INTO tab_plan_controle
          (filial, pedido, responsavel_id, responsavel_nome, status, tipo_bu, categoria, nf, obs, valor_snapshot, criado_por, atualizado_por)
        VALUES ('01', @ped, @rid, @rnome, @st, @bu, @cat, @nf, @obs, @val, @uid, @uid)
        ON CONFLICT (filial, pedido) DO UPDATE SET
          responsavel_id   = COALESCE(@rid, tab_plan_controle.responsavel_id),
          responsavel_nome = COALESCE(@rnome, tab_plan_controle.responsavel_nome),
          status           = COALESCE(NULLIF(@st,''), tab_plan_controle.status),
          tipo_bu          = COALESCE(NULLIF(@bu,''), tab_plan_controle.tipo_bu),
          categoria        = @cat, nf = @nf, obs = @obs,
          ultima_movimentacao = NOW(), atualizado_em = NOW(), atualizado_por = @uid`,
        { ped: pedido, rid: responsavelId, rnome: responsavelNome, st: statusFinal || '',
          bu: bu || '', cat: categoria, nf, obs, val: valor, uid: user?.ID || null });

      // Histórico de status
      const statusAntigo = trim(prev?.status);
      if (statusFinal && statusFinal !== statusAntigo) {
        await Pg.connectAndQuery(
          `INSERT INTO tab_plan_controle_hist (pedido, de_status, para_status, obs, usuario_id, usuario_nome)
           VALUES (@ped, @de, @para, @obs, @uid, @un)`,
          { ped: pedido, de: statusAntigo || null, para: statusFinal, obs: obs.slice(0, 300), uid: user?.ID || null, un: trim(user?.NOME) });
      }

      Auditoria.registrar(app, {
        modulo: 'Planejamento', submodulo: 'ControleFaturamento', acao: novo ? 'ADD_CONTROLE' : 'EDIT_CONTROLE',
        severidade: 'INFO', req, entidade: 'pedido', entidadeId: pedido,
        descricao: `${novo ? 'Adicionou' : 'Atualizou'} pedido ${pedido} no controle${responsavelNome ? ` (resp. ${responsavelNome})` : ''}${statusFinal ? ` · ${statusFinal}` : ''}`,
        meta: { responsavelId, status: statusFinal }
      });

      return res.json({ ok: true, pedido, novo });
    } catch (err) {
      console.error('Erro controle-salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
