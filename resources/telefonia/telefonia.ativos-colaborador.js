// GET /telefonia/ativos-colaborador?documento=CPF
// Visão 360 de um colaborador: LINHAS móveis + EQUIPAMENTOS (RH) + TERMOS de
// responsabilidade, tudo ancorado no CPF. Serve a tela "Ativos do Colaborador"
// (fase 3) e o picker de aparelho do modal de linha (fase 2 usa `equipamentos`).
// Cruza 3 tabelas de módulos diferentes pelo documento (dígitos). Perm 1027. Leitura.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');

module.exports = (app) => ({
  verb: 'get',
  route: '/ativos-colaborador',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const doc = soDig(req.query.documento);
    if (doc.length < 5) return res.status(400).json({ message: 'documento (CPF/CNPJ) obrigatório.' });

    const p = { doc };
    try {
      // Linhas do colaborador (+ operadora + aparelho vinculado)
      const linhas = await Pg.connectAndQuery(`
        SELECT l.id, l.numero_telefone, l.plano, l.valor_mensal, l.status,
               l.data_vencimento, l.id_equipamento_atual,
               o.nome AS operadora,
               NULLIF(TRIM(CONCAT_WS(' ', ea.marca, ea.modelo)), '') AS equipamento
          FROM tab_telefonia_linha l
          JOIN tab_operadora o ON o.id = l.id_operadora
          LEFT JOIN tab_equipamento_atual ea ON ea.id = l.id_equipamento_atual
         WHERE regexp_replace(COALESCE(l.documento_colaborador,''), '\\D', '', 'g') = @doc
         ORDER BY (l.status='Ativa') DESC, o.nome, l.numero_telefone`, p);

      // Equipamentos (estado atual) do colaborador
      const equipamentos = await Pg.connectAndQuery(`
        SELECT id, marca, modelo, cor, imei, numero_serie, status, data_entrega, motivo_remocao, data_remocao,
               CASE WHEN data_remocao IS NOT NULL THEN (data_remocao - data_entrega)
                    WHEN status='ATIVO' THEN (CURRENT_DATE - data_entrega) ELSE NULL END AS dias_de_uso
          FROM tab_equipamento_atual
         WHERE regexp_replace(COALESCE(documento,''), '\\D', '', 'g') = @doc
         ORDER BY (status='ATIVO') DESC, data_entrega DESC`, p);

      // Termos de responsabilidade emitidos
      const termos = await Pg.connectAndQuery(`
        SELECT id, modo, marca, modelo, cidade, data_termo, criado_em
          FROM tab_termo_equipamento
         WHERE regexp_replace(COALESCE(documento,''), '\\D', '', 'g') = @doc
         ORDER BY data_termo DESC, criado_em DESC
         LIMIT 30`, p);

      // Dados do colaborador (pega do registro mais recente disponível)
      const src = [...equipamentos, ...linhas, ...termos];
      const colabRow = await Pg.connectAndQuery(`
        SELECT nome, matricula_protheus, cargo FROM tab_equipamento_atual
         WHERE regexp_replace(COALESCE(documento,''), '\\D', '', 'g') = @doc
         ORDER BY criado_em DESC LIMIT 1`, p);
      const termoNome = await Pg.connectAndQuery(`
        SELECT nome, matricula_protheus, cargo FROM tab_termo_equipamento
         WHERE regexp_replace(COALESCE(documento,''), '\\D', '', 'g') = @doc
         ORDER BY criado_em DESC LIMIT 1`, p);
      const c0 = colabRow[0] || termoNome[0] || {};

      const fmtEquip = (e) => {
        const base = [trim(e.marca), trim(e.modelo), trim(e.cor)].filter(Boolean).join(' ') || `Equipamento #${e.id}`;
        const imei = trim(e.imei);
        return {
          id: e.id, marca: trim(e.marca), modelo: trim(e.modelo), cor: trim(e.cor),
          imei, numeroSerie: trim(e.numero_serie),
          status: trim(e.status), dataEntrega: e.data_entrega, dataRemocao: e.data_remocao,
          motivoRemocao: trim(e.motivo_remocao), diasDeUso: e.dias_de_uso != null ? Number(e.dias_de_uso) : null,
          label: imei ? `${base} · IMEI ${imei}` : base
        };
      };

      return res.json({
        documento: doc,
        colaborador: { nome: trim(c0.nome), matricula: trim(c0.matricula_protheus), cargo: trim(c0.cargo) },
        linhas: linhas.map(l => ({
          id: l.id, numero: trim(l.numero_telefone), operadora: trim(l.operadora),
          plano: trim(l.plano), valorMensal: Number(l.valor_mensal || 0), status: trim(l.status),
          dataVencimento: l.data_vencimento, idEquipamento: l.id_equipamento_atual, equipamento: trim(l.equipamento)
        })),
        equipamentos: equipamentos.map(fmtEquip),
        equipamentosAtivos: equipamentos.filter(e => trim(e.status) === 'ATIVO').map(fmtEquip),
        termos: termos.map(t => ({
          id: t.id, modo: trim(t.modo), marca: trim(t.marca), modelo: trim(t.modelo),
          cidade: trim(t.cidade), dataTermo: t.data_termo
        })),
        totais: {
          linhasAtivas: linhas.filter(l => trim(l.status) === 'Ativa').length,
          custoMensal: +linhas.filter(l => trim(l.status) === 'Ativa').reduce((s, l) => s + Number(l.valor_mensal || 0), 0).toFixed(2),
          equipamentosAtivos: equipamentos.filter(e => trim(e.status) === 'ATIVO').length
        }
      });
    } catch (err) {
      console.error('telefonia/ativos-colaborador:', err.message);
      return res.status(500).json({ message: 'Erro ao carregar ativos do colaborador: ' + err.message });
    }
  }
});
