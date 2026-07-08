// GET /recebimento/espelho?doc=&serie=&fornece=&loja=
// Espelho de conferência de uma pré-nota: cabeçalho SF1 + itens SD1 (com
// descrição/NCM da SB1). CONFERÊNCIA CEGA: a QUANTIDADE da NF só é enviada
// ao front depois que a conferência foi FINALIZADA (CONFERIDA/DIVERGENTE/
// CLASSIFICADA) — antes disso o campo simplesmente não existe na resposta.
// Rascunho devolve as qtd_conferida já digitadas. Perm 4005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4005]);
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);
const FINALIZADAS = new Set(['CONFERIDA', 'DIVERGENTE', 'CLASSIFICADA']);

module.exports = (app) => ({
  verb: 'get',
  route: '/espelho',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const doc = trim(req.query.doc), serie = trim(req.query.serie);
    const fornece = trim(req.query.fornece), loja = trim(req.query.loja);
    if (!doc || !serie || !fornece || !loja) {
      return res.status(400).json({ message: 'doc, serie, fornece e loja são obrigatórios.' });
    }

    try {
      // 1) Cabeçalho (SF1 + SA2) — vale tanto pra pré-nota quanto já classificada
      let cab;
      try {
        cab = await Protheus.connectAndQuery(`
          SELECT RTRIM(f1.F1_DOC) doc, RTRIM(f1.F1_SERIE) serie,
                 RTRIM(f1.F1_FORNECE) fornece, RTRIM(f1.F1_LOJA) loja,
                 RTRIM(f1.F1_ESPECIE) especie, RTRIM(ISNULL(f1.F1_STATUS,'')) statusSf1,
                 f1.F1_EMISSAO emissao, f1.F1_RECBMTO recbmto,
                 f1.F1_VALBRUT valorBruto, RTRIM(f1.F1_CHVNFE) chave,
                 RTRIM(COALESCE(sa2.A2_NOME, '')) fornecedorNome,
                 RTRIM(COALESCE(sa2.A2_CGC, '')) cnpj,
                 RTRIM(COALESCE(sa2.A2_INSCR, '')) inscricao
            FROM SF1010 f1 WITH (NOLOCK)
            LEFT JOIN SA2010 sa2 WITH (NOLOCK)
              ON sa2.A2_COD = f1.F1_FORNECE AND sa2.A2_LOJA = f1.F1_LOJA AND sa2.D_E_L_E_T_ <> '*'
           WHERE f1.D_E_L_E_T_ <> '*' AND f1.F1_FILIAL = '01'
             AND RTRIM(f1.F1_DOC) = @doc AND RTRIM(f1.F1_SERIE) = @serie
             AND RTRIM(f1.F1_FORNECE) = @fornece AND RTRIM(f1.F1_LOJA) = @loja`,
          { doc, serie, fornece, loja });
      } catch (err) {
        if (ehConexao(err)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
        throw err;
      }
      if (!cab.length) return res.status(404).json({ message: 'Nota não encontrada na SF1.' });
      const nota = cab[0];

      // 2) Itens (SD1 + SB1)
      const itensSd1 = await Protheus.connectAndQuery(`
        SELECT RTRIM(d1.D1_ITEM) item, RTRIM(d1.D1_COD) produto,
               RTRIM(COALESCE(b1.B1_DESC, '')) descricao,
               RTRIM(COALESCE(b1.B1_POSIPI, '')) ncm,
               RTRIM(d1.D1_UM) um, d1.D1_QUANT qtdNf,
               d1.D1_VUNIT vunit, d1.D1_TOTAL total,
               RTRIM(ISNULL(d1.D1_TES, '')) tes, RTRIM(ISNULL(d1.D1_CF, '')) cfop
          FROM SD1010 d1 WITH (NOLOCK)
          LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD = d1.D1_COD AND b1.D_E_L_E_T_ <> '*'
         WHERE d1.D_E_L_E_T_ <> '*' AND d1.D1_FILIAL = '01'
           AND RTRIM(d1.D1_DOC) = @doc AND RTRIM(d1.D1_SERIE) = @serie
           AND RTRIM(d1.D1_FORNECE) = @fornece AND RTRIM(d1.D1_LOJA) = @loja
         ORDER BY d1.D1_ITEM`,
        { doc, serie, fornece, loja });

      // 3) Estado da conferência na intranet
      const confRows = await Pg.connectAndQuery(`
        SELECT c.*, uc.nome AS conferido_por_nome, ux.nome AS classificado_por_nome
          FROM tab_receb_conferencia c
          LEFT JOIN tab_intranet_usr uc ON uc.id = c.conferido_por
          LEFT JOIN tab_intranet_usr ux ON ux.id = c.classificado_por
         WHERE c.doc = @doc AND c.serie = @serie AND c.fornece = @fornece AND c.loja = @loja`,
        { doc, serie, fornece, loja });
      const conf = confRows[0] || null;
      const statusConf = conf ? trim(conf.status) : 'AGUARDANDO';
      const finalizada = FINALIZADAS.has(statusConf);

      const itensConf = new Map();
      if (conf) {
        const ic = await Pg.connectAndQuery(
          `SELECT item, qtd_conferida, diferenca, status_item, tes, cfop
             FROM tab_receb_conferencia_item WHERE id_conf = @id`, { id: conf.id });
        ic.forEach(x => itensConf.set(trim(x.item), x));
      }

      // 4) Monta itens — qtdNf SÓ sai depois de finalizada (conferência cega)
      const itens = itensSd1.map(r => {
        const item = trim(r.item);
        const st = itensConf.get(item);
        const base = {
          item, produto: trim(r.produto), descricao: trim(r.descricao),
          ncm: trim(r.ncm), um: trim(r.um),
          vunit: N(r.vunit), total: finalizada ? N(r.total) : null,   // total revela a qtd -> também oculto
          tes: (st && trim(st.tes)) || trim(r.tes) || null,
          cfop: (st && trim(st.cfop)) || trim(r.cfop) || null,
          qtdConferida: st && st.qtd_conferida != null ? N(st.qtd_conferida) : null,
          statusItem: st ? trim(st.status_item) : 'PENDENTE'
        };
        if (finalizada) {
          base.qtdNf = N(r.qtdNf);
          base.diferenca = st && st.diferenca != null ? N(st.diferenca) : null;
        }
        return base;
      });

      return res.json({
        nota: {
          doc: trim(nota.doc), serie: trim(nota.serie),
          fornece: trim(nota.fornece), loja: trim(nota.loja),
          fornecedorNome: trim(nota.fornecedorNome), cnpj: trim(nota.cnpj), inscricao: trim(nota.inscricao),
          especie: trim(nota.especie), emissao: trim(nota.emissao), recbmto: trim(nota.recbmto),
          valorBruto: N(nota.valorBruto), chave: trim(nota.chave),
          statusSf1: trim(nota.statusSf1)   // '' = pré-nota · 'A' = já classificada no ERP
        },
        conferencia: {
          id: conf ? conf.id : null,
          status: statusConf,
          finalizada,
          observacao: conf ? trim(conf.observacao) || null : null,
          conferidoPor: conf ? trim(conf.conferido_por_nome) || null : null,
          conferidoEm: conf ? conf.conferido_em : null,
          classificadoPor: conf ? trim(conf.classificado_por_nome) || null : null,
          classificadoEm: conf ? conf.classificado_em : null
        },
        itens,
        cega: !finalizada,   // front usa pra mostrar "qtd oculta"
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('recebimento/espelho:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
