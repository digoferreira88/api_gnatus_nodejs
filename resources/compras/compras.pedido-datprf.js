// PUT /compras/pedido-datprf — altera a PREVISÃO DE ENTREGA (C7_DATPRF) de um
// item do pedido de compra, direto na SC7010.
//
// ⚠️ ESCRITA no Protheus — exceção ao read-only, junto de reserva de estoque e
// carteira simples do borderô. Porta o módulo da intranet ANTIGA
// (/compras/pedidos/edit → Models\protheus\sc7010 → saveToDB), que gravava
// direto no banco EXATAMENTE para o pedido não voltar à alçada de aprovação:
// um UPDATE de SQL não passa pela MATA121, então não mexe em C7_CONAPRO nem
// recria as linhas de aprovação da SCR010. Só a data muda.
//
// Escopo TRAVADO: 1 item, identificado por (C7_FILIAL, C7_NUM, C7_ITEM), não
// deletado. Nenhuma outra coluna é tocada. Transacional, com LOCK_TIMEOUT curto
// para não travar caso o Protheus esteja com o registro aberto.
//
// Permissão 4006 (alterar) — separada da 4002 (consulta).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4006, 0]);
const Auditoria = require('../../services/auditoria');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const trim = (v) => String(v == null ? '' : v).trim();
// 'YYYY-MM-DD' | 'YYYYMMDD' -> 'YYYYMMDD' (formato de data do Protheus)
const paraProtheus = (v) => {
  const s = trim(v).replace(/\D/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(s)) return null;
  const ano = Number(s.slice(0, 4)), mes = Number(s.slice(4, 6)), dia = Number(s.slice(6, 8));
  if (ano < 2000 || ano > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia));                      // rejeita 31/02 e afins
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return s;
};

module.exports = (app) => ({
  verb: 'put',
  route: '/pedido-datprf',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const filial = trim(b.filial) || '01';
    const numero = trim(b.numero);
    const item   = trim(b.item);
    const nova   = paraProtheus(b.dataPrevista);

    if (!numero || !item) return res.status(400).json({ message: 'Informe numero e item do pedido.' });
    if (!nova) return res.status(400).json({ message: 'Data de previsão inválida (use AAAA-MM-DD).' });

    try {
      // 1) Estado ANTES — confirma que existe, que é 1 registro só, e guarda o
      //    valor anterior para a auditoria (e para devolver ao front).
      const antes = await Protheus.connectAndQuery(`
        SELECT RTRIM(C7_FILIAL) filial, RTRIM(C7_NUM) numero, RTRIM(C7_ITEM) item,
               RTRIM(C7_PRODUTO) produto, RTRIM(C7_DESCRI) descricao,
               RTRIM(C7_DATPRF) dataPrevista, RTRIM(C7_ENCER) encer, RTRIM(C7_RESIDUO) residuo,
               C7_QUANT quant, C7_QUJE atendido
          FROM SC7010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*' AND RTRIM(C7_FILIAL) = @f
           AND RTRIM(C7_NUM) = @n AND RTRIM(C7_ITEM) = @i`,
        { f: filial, n: numero, i: item });

      if (!antes.length) return res.status(404).json({ message: `Item ${item} do pedido ${numero} não encontrado.` });
      if (antes.length > 1) return res.status(409).json({ message: 'Chave ambígua (mais de um registro) — alteração abortada por segurança.' });
      const at = antes[0];
      const anterior = trim(at.dataPrevista);

      if (anterior === nova) {
        return res.json({ ok: true, alterados: 0, anterior, nova, mensagem: 'A data informada já é a atual — nada alterado.' });
      }

      // 2) UPDATE escopado. Só C7_DATPRF; o WHERE repete a chave inteira e ainda
      //    confere a data anterior (optimistic lock: se alguém mudou no Protheus
      //    entre a leitura e agora, não sobrescreve às cegas).
      const upd = await Protheus.connectAndQuery(`
        SET NOCOUNT ON;
        SET LOCK_TIMEOUT 5000;
        BEGIN TRY
          BEGIN TRAN;
          UPDATE dbo.SC7010
             SET C7_DATPRF = @nova
           WHERE D_E_L_E_T_ <> '*' AND RTRIM(C7_FILIAL) = @f
             AND RTRIM(C7_NUM) = @n AND RTRIM(C7_ITEM) = @i
             AND RTRIM(C7_DATPRF) = @ant;
          DECLARE @n INT = @@ROWCOUNT;
          COMMIT TRAN;
          SELECT @n AS afetados, '' AS erro;
        END TRY
        BEGIN CATCH
          IF @@TRANCOUNT > 0 ROLLBACK TRAN;
          SELECT -1 AS afetados, ERROR_MESSAGE() AS erro;
        END CATCH`,
        { nova, f: filial, n: numero, i: item, ant: anterior });

      const afetados = Number(upd?.[0]?.afetados ?? 0);
      const erroSql = trim(upd?.[0]?.erro);
      if (afetados < 0) {
        console.error('pedido-datprf: erro SQL —', erroSql);
        return res.status(500).json({ message: 'Erro ao gravar no Protheus: ' + (erroSql || 'desconhecido') });
      }
      if (afetados === 0) {
        return res.status(409).json({
          message: 'A previsão foi alterada por outra pessoa (ou no Protheus) desde que a tela carregou. Recarregue e tente de novo.'
        });
      }

      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'PedidosCompra',
        acao: 'ALTERAR_PREVISAO_ENTREGA', severidade: 'CRITICO', req,
        entidade: 'pedido_compra', entidadeId: `${filial}/${numero}/${item}`,
        descricao: `Previsão de entrega do PC ${numero} item ${item} (${trim(at.produto)}): ${anterior || '—'} → ${nova}`,
        meta: { filial, numero, item, produto: trim(at.produto), anterior, nova, afetados }
      });

      return res.json({
        ok: true, alterados: afetados, filial, numero, item,
        anterior, nova,
        mensagem: `Previsão de entrega atualizada para ${nova.slice(6, 8)}/${nova.slice(4, 6)}/${nova.slice(0, 4)}.`
      });
    } catch (err) {
      if (ehConexao(err)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
      console.error('compras/pedido-datprf:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
