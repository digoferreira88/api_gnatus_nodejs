// POST /recebimento/conferir
// Body: { doc, serie, fornece, loja, finalizar: bool, observacao?, itens: [{item, qtdConferida}] }
//
// Salva a contagem física da conferência CEGA. A diferença é calculada NO
// SERVIDOR contra a SD1 (fonte da verdade) — o front nunca vê a qtd da NF antes
// de finalizar. finalizar=false grava RASCUNHO (sem revelar nada);
// finalizar=true fecha: todas dif=0 -> CONFERIDA, senão DIVERGENTE (e aí a
// resposta revela qtdNf/diferenca por item). Perm 4005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4005]);
const Auditoria = require('../../services/auditoria');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/conferir',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const b = req.body || {};
    const doc = trim(b.doc), serie = trim(b.serie), fornece = trim(b.fornece), loja = trim(b.loja);
    const finalizar = b.finalizar === true;
    const observacao = trim(b.observacao).slice(0, 2000) || null;
    const itensInformados = Array.isArray(b.itens) ? b.itens : [];
    if (!doc || !serie || !fornece || !loja) {
      return res.status(400).json({ message: 'doc, serie, fornece e loja são obrigatórios.' });
    }

    try {
      // 1) Já classificada? Não deixa mexer.
      const atual = await Pg.connectAndQuery(
        `SELECT id, status FROM tab_receb_conferencia
          WHERE doc=@doc AND serie=@serie AND fornece=@fornece AND loja=@loja`,
        { doc, serie, fornece, loja });
      if (atual.length && trim(atual[0].status) === 'CLASSIFICADA') {
        return res.status(409).json({ message: 'Nota já classificada — conferência travada.' });
      }

      // 2) Fonte da verdade: cabeçalho + itens no Protheus
      let cab, itensSd1;
      try {
        cab = await Protheus.connectAndQuery(`
          SELECT RTRIM(f1.F1_ESPECIE) especie, f1.F1_EMISSAO emissao, f1.F1_RECBMTO recbmto,
                 f1.F1_VALBRUT valorBruto, RTRIM(f1.F1_CHVNFE) chave,
                 RTRIM(COALESCE(sa2.A2_NREDUZ, sa2.A2_NOME, '')) fornecedorNome
            FROM SF1010 f1 WITH (NOLOCK)
            LEFT JOIN SA2010 sa2 WITH (NOLOCK)
              ON sa2.A2_COD = f1.F1_FORNECE AND sa2.A2_LOJA = f1.F1_LOJA AND sa2.D_E_L_E_T_ <> '*'
           WHERE f1.D_E_L_E_T_ <> '*' AND f1.F1_FILIAL = '01'
             AND RTRIM(f1.F1_DOC)=@doc AND RTRIM(f1.F1_SERIE)=@serie
             AND RTRIM(f1.F1_FORNECE)=@fornece AND RTRIM(f1.F1_LOJA)=@loja`,
          { doc, serie, fornece, loja });
        if (!cab.length) return res.status(404).json({ message: 'Nota não encontrada na SF1.' });

        itensSd1 = await Protheus.connectAndQuery(`
          SELECT RTRIM(d1.D1_ITEM) item, RTRIM(d1.D1_COD) produto,
                 RTRIM(COALESCE(b1.B1_DESC, '')) descricao,
                 RTRIM(COALESCE(b1.B1_POSIPI, '')) ncm,
                 RTRIM(d1.D1_UM) um, d1.D1_QUANT qtdNf, d1.D1_VUNIT vunit, d1.D1_TOTAL total
            FROM SD1010 d1 WITH (NOLOCK)
            LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD = d1.D1_COD AND b1.D_E_L_E_T_ <> '*'
           WHERE d1.D_E_L_E_T_ <> '*' AND d1.D1_FILIAL = '01'
             AND RTRIM(d1.D1_DOC)=@doc AND RTRIM(d1.D1_SERIE)=@serie
             AND RTRIM(d1.D1_FORNECE)=@fornece AND RTRIM(d1.D1_LOJA)=@loja
           ORDER BY d1.D1_ITEM`, { doc, serie, fornece, loja });
      } catch (err) {
        if (ehConexao(err)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
        throw err;
      }
      if (!itensSd1.length) return res.status(400).json({ message: 'Nota sem itens na SD1.' });

      const informadaPorItem = new Map();
      itensInformados.forEach(i => {
        const qc = i.qtdConferida;
        informadaPorItem.set(trim(i.item), (qc === '' || qc == null) ? null : N(qc));
      });

      // Ao FINALIZAR, todos os itens precisam ter contagem
      if (finalizar) {
        const faltando = itensSd1.filter(r => informadaPorItem.get(trim(r.item)) == null);
        if (faltando.length) {
          return res.status(400).json({
            message: `Informe a quantidade conferida de todos os itens (${faltando.length} pendente(s)).`,
            itensPendentes: faltando.map(r => trim(r.item))
          });
        }
      }

      // 3) Upsert do cabeçalho
      const n = cab[0];
      const up = await Pg.connectAndQuery(`
        INSERT INTO tab_receb_conferencia
          (doc, serie, fornece, loja, fornecedor_nome, especie, emissao, recbmto,
           valor_bruto, chave_nfe, qt_itens, status, observacao,
           conferido_por, conferido_em, atualizado_em)
        VALUES (@doc, @serie, @fornece, @loja, @forn, @esp, @emi, @rec,
                @vb, @chv, @qt, @st, @obs,
                @uid, CASE WHEN @fin THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (doc, serie, fornece, loja) DO UPDATE SET
          fornecedor_nome=@forn, especie=@esp, emissao=@emi, recbmto=@rec,
          valor_bruto=@vb, chave_nfe=@chv, qt_itens=@qt,
          status=@st, observacao=@obs,
          conferido_por=@uid,
          conferido_em=CASE WHEN @fin THEN NOW() ELSE tab_receb_conferencia.conferido_em END,
          atualizado_em=NOW()
        RETURNING id`,
        {
          doc, serie, fornece, loja,
          forn: trim(n.fornecedorNome), esp: trim(n.especie),
          emi: trim(n.emissao), rec: trim(n.recbmto),
          vb: N(n.valorBruto), chv: trim(n.chave), qt: itensSd1.length,
          st: 'RASCUNHO',   // status final decidido abaixo (após calcular difs)
          obs: observacao, uid: user.ID, fin: finalizar
        });
      const idConf = up[0].id;

      // 4) Upsert dos itens — diferença calculada SÓ no finalizar
      let divergentes = 0;
      const resultadoItens = [];
      for (const r of itensSd1) {
        const item = trim(r.item);
        const qtdNf = N(r.qtdNf);
        const qc = informadaPorItem.has(item) ? informadaPorItem.get(item) : undefined;
        let diferenca = null, statusItem = 'PENDENTE';
        if (finalizar) {
          diferenca = N(qc) - qtdNf;
          statusItem = diferenca === 0 ? 'OK' : 'DIVERGENTE';
          if (statusItem === 'DIVERGENTE') divergentes++;
        }
        await Pg.connectAndQuery(`
          INSERT INTO tab_receb_conferencia_item
            (id_conf, item, produto, descricao, ncm, um, qtd_nf, qtd_conferida, diferenca, vunit, total, status_item)
          VALUES (@id, @item, @prod, @desc, @ncm, @um, @qnf, @qc, @dif, @vu, @tot, @sti)
          ON CONFLICT (id_conf, item) DO UPDATE SET
            produto=@prod, descricao=@desc, ncm=@ncm, um=@um, qtd_nf=@qnf,
            qtd_conferida=CASE WHEN @qcSet THEN @qc ELSE tab_receb_conferencia_item.qtd_conferida END,
            diferenca=@dif, vunit=@vu, total=@tot, status_item=@sti`,
          {
            id: idConf, item, prod: trim(r.produto), desc: trim(r.descricao),
            ncm: trim(r.ncm), um: trim(r.um), qnf: qtdNf,
            qc: qc == null ? null : N(qc), qcSet: qc !== undefined,
            dif: diferenca, vu: N(r.vunit), tot: N(r.total), sti: statusItem
          });
        if (finalizar) {
          resultadoItens.push({ item, produto: trim(r.produto), qtdNf, qtdConferida: N(qc), diferenca, statusItem });
        }
      }

      // 5) Status final do cabeçalho
      const statusFinal = finalizar ? (divergentes > 0 ? 'DIVERGENTE' : 'CONFERIDA') : 'RASCUNHO';
      await Pg.connectAndQuery(
        `UPDATE tab_receb_conferencia SET status=@st, atualizado_em=NOW() WHERE id=@id`,
        { st: statusFinal, id: idConf });

      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'RecebimentoNF',
        acao: finalizar ? 'CONFERIR_FINALIZAR' : 'CONFERIR_RASCUNHO',
        severidade: finalizar ? 'CRITICO' : 'INFO', req,
        entidade: 'receb_conferencia', entidadeId: String(idConf),
        descricao: finalizar
          ? `Finalizou conferência da NF ${doc}/${serie} (${trim(n.fornecedorNome)}): ${statusFinal}${divergentes ? ` — ${divergentes} item(ns) divergente(s)` : ''}`
          : `Salvou rascunho da conferência da NF ${doc}/${serie}`,
        meta: { doc, serie, fornece, loja, status: statusFinal, divergentes }
      });

      // Rascunho: NÃO revela nada. Finalizada: devolve o resultado item a item.
      return res.json({
        ok: true, id: idConf, status: statusFinal,
        ...(finalizar ? { divergentes, itens: resultadoItens } : {})
      });
    } catch (err) {
      console.error('recebimento/conferir:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
