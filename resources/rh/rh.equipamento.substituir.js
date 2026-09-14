// Substitui um equipamento por outro.
// Marca o antigo como SUBSTITUIDO + cria novo registro ATIVO + linka via id_substituicao.
//
// Body: { motivo, obs?, equipamento: {marca, modelo, cor, novo, acessorios, condicoes}, dataEntrega? }

const trim = (v) => v == null ? null : String(v).trim() || null;
const MOTIVOS = ['DEFEITO','PERDA','FIM_CONTRATO','UPGRADE','OUTRO'];

module.exports = (app) => ({
  verb: 'put',
  route: '/equipamento/:id/substituir',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'ID inválido.' });

    const b = req.body || {};
    const motivo = String(b.motivo || '').toUpperCase();
    if (!MOTIVOS.includes(motivo)) {
      return res.status(400).json({ message: `motivo deve ser um de: ${MOTIVOS.join(', ')}` });
    }

    const obs = trim(b.obs);
    const eq  = b.equipamento || {};
    if (!eq.marca && !eq.modelo) {
      return res.status(400).json({ message: 'Marca ou modelo do novo equipamento é obrigatório.' });
    }
    const dataEntrega = b.dataEntrega || new Date().toISOString().slice(0, 10);

    try {
      // Busca o equipamento antigo (precisa estar ATIVO + dados do colaborador)
      const ant = await Pg.connectAndQuery(
        `SELECT id, documento, nome, matricula_protheus, cargo, status
           FROM tab_equipamento_atual WHERE id = @id`,
        { id }
      );
      if (ant.length === 0) return res.status(404).json({ message: 'Equipamento não encontrado.' });
      if (ant[0].status !== 'ATIVO') {
        return res.status(400).json({ message: `Equipamento não está ativo (status atual: ${ant[0].status}).` });
      }

      // Cria o novo (carrega dados do colaborador do antigo)
      const novo = await Pg.connectAndQuery(`
        INSERT INTO tab_equipamento_atual (
          documento, nome, matricula_protheus, cargo,
          marca, modelo, cor, novo, acessorios, condicoes, imei, numero_serie,
          data_entrega, status, registrado_por
        ) VALUES (
          @doc, @nome, @mat, @cargo,
          @marca, @modelo, @cor, @novo, @ace, @cond, @imei, @serie,
          @data, 'ATIVO', @uid
        )
        RETURNING id
      `, {
        doc: ant[0].documento, nome: ant[0].nome,
        mat: ant[0].matricula_protheus, cargo: ant[0].cargo,
        marca: trim(eq.marca), modelo: trim(eq.modelo), cor: trim(eq.cor),
        novo: typeof eq.novo === 'boolean' ? eq.novo : null,
        ace: trim(eq.acessorios), cond: trim(eq.condicoes),
        imei: trim(eq.imei), serie: trim(eq.numeroSerie),
        data: dataEntrega, uid: user.ID
      });
      const novoId = novo[0]?.id;

      // Marca o antigo como SUBSTITUIDO + linka pro novo
      await Pg.connectAndQuery(`
        UPDATE tab_equipamento_atual
           SET status = 'SUBSTITUIDO',
               data_remocao = @data,
               motivo_remocao = @motivo,
               obs_remocao = @obs,
               id_substituicao = @novoId,
               atualizado_em = NOW()
         WHERE id = @id
      `, { id, data: dataEntrega, motivo, obs, novoId });

      return res.json({ ok: true, idAntigo: id, idNovo: novoId });
    } catch (err) {
      console.error('Erro rh/equipamento:substituir:', err);
      return res.status(500).json({ message: 'Erro ao substituir equipamento.' });
    }
  }
});
