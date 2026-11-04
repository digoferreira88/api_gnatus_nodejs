// POST /financeiro/credito-registro        -> cria um registro NOVO (versão 1)
// POST /financeiro/credito-registro/:grupo  -> cria NOVA VERSÃO do grupo (edição)
//
// Registro permanente de análise de crédito. APPEND-ONLY: nunca sobrescreve.
// Editar = nova versão (versao+1), a anterior vira vigente=false + substituido_por.
// O histórico é preservado integralmente. Perm 8006. Auditoria CRITICO.
//
// Anti-duplicidade: registro NOVO de um CPF/CNPJ que já tem análise vigente nos
// últimos JANELA_DUPLICIDADE_DIAS responde 409 com as análises anteriores. Para
// gravar mesmo assim, o front reenvia com `confirmarDuplicidade: true` (fica
// marcado em duplicidade_confirmada). A análise nova é ligada à anterior do mesmo
// documento (anterior_grupo_id), em qualquer data.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);
const Auditoria = require('../../services/auditoria');
const CR = require('../../services/creditoRegistro');

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/credito-registro/:grupo?',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const grupoEdit = req.params.grupo ? Number(req.params.grupo) : null;
    if (grupoEdit !== null && (!Number.isInteger(grupoEdit) || grupoEdit <= 0)) {
      return res.status(400).json({ message: 'grupo inválido.' });
    }

    const v = CR.validar(req.body, { novo: !grupoEdit });
    if (!v.ok) return res.status(400).json({ message: v.erros[0], erros: v.erros });
    const d = v.dados;
    const c = d.condicoes;
    const nome = trim(user.NOME) || trim(user.EMAIL);
    const confirmou = req.body && req.body.confirmarDuplicidade === true;

    try {
      // Análises vigentes do mesmo CPF/CNPJ (fora o próprio grupo, na edição).
      let anteriores = [];
      if (d.cnpj) {
        anteriores = await Pg.connectAndQuery(`
          SELECT grupo_id, resultado, analista_nome, pedido, criado_em,
                 (criado_em >= NOW() - make_interval(days => @janela::int)) AS recente
            FROM tab_credito_registro
           WHERE vigente AND documento = @doc AND grupo_id <> @grupo::int
           ORDER BY criado_em DESC
           LIMIT 10`,
          { doc: d.cnpj, grupo: grupoEdit || 0, janela: CR.JANELA_DUPLICIDADE_DIAS });
      }
      const recentes = anteriores.filter((a) => a.recente);

      if (!grupoEdit && recentes.length && !confirmou) {
        return res.status(409).json({
          duplicidade: true,
          janelaDias: CR.JANELA_DUPLICIDADE_DIAS,
          message: `Este CPF/CNPJ já tem ${recentes.length} análise(s) nos últimos ${CR.JANELA_DUPLICIDADE_DIAS} dias.`,
          anteriores: recentes.map((a) => ({
            grupoId: a.grupo_id, resultado: trim(a.resultado), analistaNome: trim(a.analista_nome),
            pedido: trim(a.pedido), criadoEm: a.criado_em
          }))
        });
      }

      const resultado = await Pg.withTransaction(async (client) => {
        let grupoId = null, versao = 1, anteriorId = null;
        let anteriorGrupo = anteriores[0] ? anteriores[0].grupo_id : null;
        let dupConfirmada = !grupoEdit && recentes.length > 0 && confirmou;

        if (grupoEdit) {
          // Nova versão: acha a versão vigente do grupo (trava a linha contra edição simultânea)
          const atual = await client.query(
            `SELECT id, versao, anterior_grupo_id, duplicidade_confirmada FROM tab_credito_registro
              WHERE grupo_id = $1 AND vigente = TRUE ORDER BY versao DESC LIMIT 1 FOR UPDATE`, [grupoEdit]);
          if (!atual.rows.length) return { naoAchou: true };
          anteriorId = atual.rows[0].id;
          versao = Number(atual.rows[0].versao) + 1;
          grupoId = grupoEdit;
          // A ligação com a análise anterior é do grupo: a versão nova herda.
          anteriorGrupo = atual.rows[0].anterior_grupo_id || anteriorGrupo;
          dupConfirmada = !!atual.rows[0].duplicidade_confirmada;
        }

        const ins = await client.query(`
          INSERT INTO tab_credito_registro (
            grupo_id, versao, vigente,
            bu_cod, bu_nome, pedido, cliente_cod, cliente_loja, cliente_nome, cnpj,
            valor_total, valor_entrada, parcelas_qtd, parcelas_valor,
            tipo_analise, canal, canal_origem, resultado, motivos, parecer,
            analista_id, analista_nome,
            cond_forma_pagamento, cond_valor_max, cond_entrada_min_pct, cond_parcelas_max, cond_validade, cond_observacao,
            solicitado_em, anterior_grupo_id, duplicidade_confirmada
          ) VALUES (
            $1, $2, TRUE,
            $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19,
            $20, $21,
            $22, $23, $24, $25, $26, $27,
            $28, $29, $30
          ) RETURNING id, criado_em`,
          [
            grupoId || 0, versao,
            d.buCod, d.buNome, d.pedido, d.clienteCod, d.clienteLoja, d.clienteNome, d.cnpj,
            d.valorTotal, d.valorEntrada, d.parcelasQtd, d.parcelasValor,
            d.tipoAnalise, d.canal, d.canalOrigem, d.resultado, d.motivos, d.parecer,
            user.ID, nome,
            c.formaPagamento, c.valorMax, c.entradaMinPct, c.parcelasMax, c.validade, c.observacao,
            d.solicitadoEm, anteriorGrupo, dupConfirmada
          ]);
        const novoId = ins.rows[0].id;

        // Versão 1: grupo_id = próprio id. Edição: fecha a versão anterior.
        if (!grupoEdit) {
          await client.query(`UPDATE tab_credito_registro SET grupo_id = $1 WHERE id = $1`, [novoId]);
          grupoId = novoId;
        } else {
          await client.query(
            `UPDATE tab_credito_registro SET vigente = FALSE, substituido_por = $1 WHERE id = $2`,
            [novoId, anteriorId]);
        }
        return { novoId, grupoId, versao, criadoEm: ins.rows[0].criado_em, dupConfirmada, anteriorGrupo };
      });

      if (resultado.naoAchou) return res.status(404).json({ message: 'Registro não encontrado para editar.' });
      const { novoId, grupoId, versao } = resultado;

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'RegistroCredito',
        acao: grupoEdit ? 'REGISTRO_NOVA_VERSAO' : 'REGISTRO_CRIAR', severidade: 'CRITICO', req,
        entidade: 'credito_registro', entidadeId: String(novoId),
        descricao: grupoEdit
          ? `Nova versão (v${versao}) da análise ${grupoId} — ${d.resultado} · ${d.clienteNome || d.clienteCod || 'cliente'}${d.pedido ? ' · pedido ' + d.pedido : ''}`
          : `Registrou análise de crédito — ${d.resultado} · ${d.clienteNome || d.clienteCod || 'cliente'}${d.pedido ? ' · pedido ' + d.pedido : ''} (${d.canal})`
            + (resultado.dupConfirmada ? ` · confirmou mesmo com análise recente do CPF/CNPJ (anterior: ${resultado.anteriorGrupo})` : ''),
        meta: {
          grupoId, versao, resultado: d.resultado, canal: d.canal, tipo: d.tipoAnalise, pedido: d.pedido,
          anteriorGrupoId: resultado.anteriorGrupo, duplicidadeConfirmada: resultado.dupConfirmada
        }
      });

      return res.json({ ok: true, id: novoId, grupoId, versao, criadoEm: resultado.criadoEm });
    } catch (err) {
      console.error('financeiro/credito-registro salvar:', err);
      return res.status(500).json({ message: 'Erro ao salvar registro: ' + err.message });
    }
  }
});
