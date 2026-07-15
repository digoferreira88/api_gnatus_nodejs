// POST /sac/nps/link  Body: { pedido }
// Gera (ou reaproveita) o convite de um pedido e devolve o link + QR code (PNG
// data URL) — útil p/ envio manual ou impressão na NF/caixa. Busca os dados do
// pedido no Protheus (cliente/BU/vendedor/transportadora/linha). Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const NPS = require('../../services/npsPosvenda');
const QRCode = require('qrcode');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/nps/link',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const pedido = trim(req.body?.pedido);
    if (!pedido) return res.status(400).json({ message: 'Informe o número do pedido.' });

    try {
      // convite existente?
      let conv = await Pg.connectAndQuery(
        `SELECT id, token FROM tab_nps_convite WHERE filial='01' AND pedido=@p`, { p: pedido });

      if (!conv.length) {
        // busca dados do pedido no Protheus
        const r = await Protheus.connectAndQuery(`
          SELECT TOP 1 RTRIM(sc5.C5_CLIENTE) cod, RTRIM(sc5.C5_LOJACLI) loja, RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_CGC) cgc,
                 RTRIM(sc5.C5_ZTIPO) buCod, RTRIM(x5.X5_DESCRI) buNome,
                 RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
                 RTRIM(sc5.C5_TRANSP) transpCod, RTRIM(sa4.A4_NOME) transpNome,
                 CAST(ISNULL(tp.total,0) AS NUMERIC(15,2)) valor
            FROM SC5010 sc5 WITH (NOLOCK)
            LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD=sc5.C5_CLIENTE AND sa1.A1_LOJA=sc5.C5_LOJACLI AND sa1.D_E_L_E_T_<>'*'
            LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA)='Z1' AND RTRIM(x5.X5_CHAVE)=RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_<>'*'
            LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD=sc5.C5_VEND1 AND sa3.D_E_L_E_T_<>'*'
            LEFT JOIN SA4010 sa4 WITH (NOLOCK) ON sa4.A4_COD=sc5.C5_TRANSP AND sa4.D_E_L_E_T_<>'*'
            LEFT JOIN total_pedido_sc6 tp WITH (NOLOCK) ON tp.c6_num=sc5.C5_NUM
           WHERE sc5.C5_FILIAL='01' AND RTRIM(sc5.C5_NUM)=@p AND sc5.D_E_L_E_T_<>'*'`, { p: pedido });
        if (!r.length) return res.status(404).json({ message: `Pedido ${pedido} não encontrado no Protheus.` });
        const d = r[0];
        const cfg = await NPS.lerConfig(Pg);
        const token = NPS.gerarToken();
        const ins = await Pg.connectAndQuery(`
          INSERT INTO tab_nps_convite (token, pedido, filial, cliente_cod, cliente_loja, cliente_nome, cnpj, valor_pedido,
                                       bu_cod, bu_nome, vendedor_cod, vendedor_nome, transportadora_cod, transportadora_nome,
                                       status, canal, expira_em)
          VALUES (@token, @p, '01', @cod, @loja, @nome, @cnpj, @valor, @buCod, @buNome, @vendCod, @vendNome, @transpCod, @transpNome,
                  'ENVIADO', 'MANUAL', NOW() + (@dias || ' days')::interval)
          RETURNING id, token`,
          {
            token, p: pedido, cod: trim(d.cod), loja: trim(d.loja), nome: trim(d.nome), cnpj: trim(d.cgc), valor: N(d.valor),
            buCod: trim(d.buCod), buNome: trim(d.buNome), vendCod: trim(d.vendCod), vendNome: trim(d.vendNome),
            transpCod: trim(d.transpCod), transpNome: trim(d.transpNome), dias: String(cfg.expiraDias)
          });
        conv = ins;
      }

      const token = trim(conv[0].token);
      const link = NPS.linkPesquisa(token);
      const qr = await QRCode.toDataURL(link, { width: 320, margin: 1 });
      return res.json({ ok: true, link, qr, conviteId: conv[0].id });
    } catch (err) {
      console.error('sac/nps-link:', err);
      return res.status(500).json({ message: 'Erro ao gerar link: ' + err.message });
    }
  }
});
