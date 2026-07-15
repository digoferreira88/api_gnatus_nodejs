// POST /financeiro/credito-registro        -> cria um registro NOVO (versão 1)
// POST /financeiro/credito-registro/:grupo  -> cria NOVA VERSÃO do grupo (edição)
//
// Registro permanente de análise de crédito. APPEND-ONLY: nunca sobrescreve.
// Editar = nova versão (versao+1), a anterior vira vigente=false + substituido_por.
// O histórico é preservado integralmente. Perm 8006. Auditoria CRITICO.

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

    const v = CR.validar(req.body);
    if (!v.ok) return res.status(400).json({ message: v.erros[0], erros: v.erros });
    const d = v.dados;
    const nome = trim(user.NOME) || trim(user.EMAIL);

    try {
      let grupoId, versao, anteriorId = null;

      if (grupoEdit) {
        // Nova versão: acha a versão vigente do grupo
        const atual = await Pg.connectAndQuery(
          `SELECT id, versao FROM tab_credito_registro
            WHERE grupo_id = @g AND vigente = TRUE ORDER BY versao DESC LIMIT 1`,
          { g: grupoEdit });
        if (!atual.length) return res.status(404).json({ message: 'Registro não encontrado para editar.' });
        anteriorId = atual[0].id;
        versao = Number(atual[0].versao) + 1;
        grupoId = grupoEdit;
      } else {
        versao = 1;
      }

      // Insere a nova linha (vigente)
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_credito_registro (
          grupo_id, versao, vigente,
          bu_cod, bu_nome, pedido, cliente_cod, cliente_loja, cliente_nome, cnpj,
          valor_total, valor_entrada, parcelas_qtd, parcelas_valor,
          tipo_analise, canal, canal_origem, resultado, motivos, parecer,
          analista_id, analista_nome
        ) VALUES (
          @grupo, @versao, TRUE,
          @buCod, @buNome, @pedido, @cliCod, @cliLoja, @cliNome, @cnpj,
          @vTotal, @vEntrada, @pQtd, @pValor,
          @tipo, @canal, @canalOrig, @resultado, @motivos, @parecer,
          @uid, @unome
        ) RETURNING id, criado_em`,
        {
          grupo: grupoId || 0, versao,
          buCod: d.buCod, buNome: d.buNome, pedido: d.pedido,
          cliCod: d.clienteCod, cliLoja: d.clienteLoja, cliNome: d.clienteNome, cnpj: d.cnpj,
          vTotal: d.valorTotal, vEntrada: d.valorEntrada, pQtd: d.parcelasQtd, pValor: d.parcelasValor,
          tipo: d.tipoAnalise, canal: d.canal, canalOrig: d.canalOrigem,
          resultado: d.resultado, motivos: d.motivos, parecer: d.parecer,
          uid: user.ID, unome: nome
        });
      const novoId = ins[0].id;

      // Versão 1: grupo_id = próprio id. Edição: fecha a versão anterior.
      if (!grupoEdit) {
        await Pg.connectAndQuery(`UPDATE tab_credito_registro SET grupo_id = @id WHERE id = @id`, { id: novoId });
        grupoId = novoId;
      } else {
        await Pg.connectAndQuery(
          `UPDATE tab_credito_registro SET vigente = FALSE, substituido_por = @novo WHERE id = @ant`,
          { novo: novoId, ant: anteriorId });
      }

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'RegistroCredito',
        acao: grupoEdit ? 'REGISTRO_NOVA_VERSAO' : 'REGISTRO_CRIAR', severidade: 'CRITICO', req,
        entidade: 'credito_registro', entidadeId: String(novoId),
        descricao: grupoEdit
          ? `Nova versão (v${versao}) da análise ${grupoId} — ${d.resultado} · ${d.clienteNome || d.clienteCod || 'cliente'}${d.pedido ? ' · pedido ' + d.pedido : ''}`
          : `Registrou análise de crédito — ${d.resultado} · ${d.clienteNome || d.clienteCod || 'cliente'}${d.pedido ? ' · pedido ' + d.pedido : ''} (${d.canal})`,
        meta: { grupoId, versao, resultado: d.resultado, canal: d.canal, tipo: d.tipoAnalise, pedido: d.pedido }
      });

      return res.json({ ok: true, id: novoId, grupoId, versao, criadoEm: ins[0].criado_em });
    } catch (err) {
      console.error('financeiro/credito-registro salvar:', err);
      return res.status(500).json({ message: 'Erro ao salvar registro: ' + err.message });
    }
  }
});
