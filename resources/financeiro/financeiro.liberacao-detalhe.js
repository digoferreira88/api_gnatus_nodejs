// GET /financeiro/liberacao/:pedido
//
// Detalhe de um pedido na tela de Liberação Financeira:
//   - itens:        linhas do SC6 (produto, qtd, saldo, preço, total, TES, CFOP, armazém)
//   - observacoes:  campos de observação do SC5 que estiverem preenchidos
//   - conhecimento: anexos do pedido (AC9010 + ACB010, AC9_ENTIDA = 'SC5')
//
// O download de cada conhecimento é feito por GET /financeiro/liberacao/anexo/:codObj.
//
// Permissão 8006 (edição) ou 8007 (somente visualização).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006, 8007]);

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// Campos de observação do SC5 (todos varchar) -> label de exibição.
// Mostrados só quando não vazios. C6_VDOBS (image) fica de fora — não guarda texto útil.
const CAMPOS_OBS = [
  { campo: 'mennota', label: 'Mensagem da Nota' },
  { campo: 'coment',  label: 'Comentário' },
  { campo: 'obsfisc', label: 'Obs. Fiscal' },
  { campo: 'obsplan', label: 'Obs. Planejamento' },
  { campo: 'menpad',  label: 'Mensagem Padrão' }
];

module.exports = (app) => ({
  verb: 'get',
  route: '/liberacao/:pedido',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const pedido = trim(req.params.pedido);
    if (!pedido || pedido.length > 10) {
      return res.status(400).json({ message: 'pedido inválido.' });
    }

    try {
      // 1) Observações (cabeçalho do pedido)
      const obsRows = await Protheus.connectAndQuery(`
        SELECT RTRIM(C5_MENNOTA) mennota,
               RTRIM(C5_COMENT)  coment,
               RTRIM(C5_OBSFISC) obsfisc,
               RTRIM(C5_OBSPLAN) obsplan,
               RTRIM(C5_MENPAD)  menpad
          FROM SC5010 WITH (NOLOCK)
         WHERE C5_FILIAL = '01' AND C5_NUM = @p AND D_E_L_E_T_ <> '*'`,
        { p: pedido }
      );
      const obsRaw = obsRows[0] || {};
      const observacoes = CAMPOS_OBS
        .map(c => ({ label: c.label, valor: trim(obsRaw[c.campo]) }))
        .filter(o => o.valor);

      // 2) Itens do pedido
      const itensRows = await Protheus.connectAndQuery(`
        SELECT sc6.C6_ITEM            item,
               RTRIM(sc6.C6_PRODUTO)  produto,
               RTRIM(sc6.C6_DESCRI)   descricao,
               RTRIM(sc6.C6_UM)       um,
               sc6.C6_QTDVEN          qtdVen,
               sc6.C6_QTDENT          qtdEnt,
               (sc6.C6_QTDVEN - sc6.C6_QTDENT) saldo,
               sc6.C6_PRCVEN          prcVen,
               sc6.C6_VALOR           valor,
               RTRIM(sc6.C6_LOCAL)    local,
               RTRIM(sc6.C6_TES)      tes,
               RTRIM(sc6.C6_CF)       cfop,
               RTRIM(sc6.C6_BLQ)      blq,
               RTRIM(sc6.C6_OBSCONT)  obsItem
          FROM SC6010 sc6 WITH (NOLOCK)
         WHERE sc6.C6_FILIAL = '01' AND sc6.C6_NUM = @p AND sc6.D_E_L_E_T_ <> '*'
         ORDER BY sc6.C6_ITEM`,
        { p: pedido }
      );
      const itens = itensRows.map(r => ({
        item: trim(r.item),
        produto: trim(r.produto),
        descricao: trim(r.descricao),
        um: trim(r.um),
        qtdVen: N(r.qtdVen),
        qtdEnt: N(r.qtdEnt),
        saldo: N(r.saldo),
        prcVen: N(r.prcVen),
        valor: N(r.valor),
        local: trim(r.local),
        tes: trim(r.tes),
        cfop: trim(r.cfop),
        bloqueado: trim(r.blq) !== '' && trim(r.blq) !== ' ',
        obsItem: trim(r.obsItem)
      }));

      // 3) Conhecimento (anexos) — AC9_ENTIDA = 'SC5', AC9_CODENT = nº do pedido
      let conhecimento = [];
      try {
        const anx = await Protheus.connectAndQuery(`
          SELECT RTRIM(ac9.AC9_CODOBJ) codObj,
                 RTRIM(acb.ACB_OBJETO) nome,
                 RTRIM(acb.ACB_DESCRI) descricao
            FROM AC9010 ac9 WITH (NOLOCK)
            INNER JOIN ACB010 acb WITH (NOLOCK)
              ON acb.ACB_CODOBJ = ac9.AC9_CODOBJ AND acb.D_E_L_E_T_ <> '*'
           WHERE ac9.D_E_L_E_T_ <> '*'
             AND RTRIM(ac9.AC9_ENTIDA) = 'SC5'
             AND RTRIM(ac9.AC9_CODENT) = @p`,
          { p: pedido }
        );
        conhecimento = anx.map(a => ({
          codObj: trim(a.codObj),
          nome: trim(a.nome),
          descricao: trim(a.descricao)
        }));
      } catch (e) {
        console.warn('liberacao-detalhe: falha ao buscar conhecimento —', e.message);
      }

      return res.json({
        pedido,
        observacoes,
        itens,
        conhecimento,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro financeiro/liberacao detalhe:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
