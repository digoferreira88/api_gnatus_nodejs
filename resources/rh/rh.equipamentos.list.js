// Lista todos os equipamentos (ativos e historico) agrupados por colaborador.
// O frontend agrupa por documento e separa ativos de historico.
// Calcula tempo de uso (data_remocao - data_entrega) para os removidos.

module.exports = (app) => ({
  verb: 'get',
  route: '/equipamentos',

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT
          e.id, e.documento, e.nome, e.matricula_protheus, e.cargo,
          e.marca, e.modelo, e.cor, e.novo, e.acessorios, e.condicoes, e.imei, e.numero_serie,
          e.data_entrega, e.status, e.data_remocao, e.motivo_remocao, e.obs_remocao,
          e.id_termo_origem, e.id_substituicao, e.criado_em,
          u.nome AS registrado_por_nome,
          CASE
            WHEN e.data_remocao IS NOT NULL
              THEN (e.data_remocao - e.data_entrega)
            WHEN e.status = 'ATIVO'
              THEN (CURRENT_DATE - e.data_entrega)
            ELSE NULL
          END AS dias_de_uso
        FROM tab_equipamento_atual e
        LEFT JOIN tab_intranet_usr u ON u.id = e.registrado_por
        ORDER BY e.documento, e.status, e.data_entrega DESC
      `, {});

      return res.json({
        equipamentos: rows.map(r => ({
          id: r.id,
          documento: r.documento,
          nome: r.nome,
          matriculaProtheus: r.matricula_protheus,
          cargo: r.cargo,
          marca: r.marca,
          modelo: r.modelo,
          cor: r.cor,
          novo: r.novo,
          acessorios: r.acessorios,
          condicoes: r.condicoes,
          imei: r.imei,
          numeroSerie: r.numero_serie,
          dataEntrega: r.data_entrega,
          status: r.status,
          dataRemocao: r.data_remocao,
          motivoRemocao: r.motivo_remocao,
          obsRemocao: r.obs_remocao,
          idTermoOrigem: r.id_termo_origem,
          idSubstituicao: r.id_substituicao,
          registradoPorNome: r.registrado_por_nome,
          diasDeUso: r.dias_de_uso != null ? Number(r.dias_de_uso) : null,
          criadoEm: r.criado_em
        }))
      });
    } catch (err) {
      console.error('Erro rh/equipamentos:list:', err);
      return res.status(500).json({ message: 'Erro ao listar equipamentos.' });
    }
  }
});
