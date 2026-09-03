// POST /expedicao/expedir/:doc/:serie
//
// Grava a expedicao de uma NF no Protheus: pra cada item da NF (SD2), faz
// UPSERT em SZ1010 com a data de expedicao + codigo de rastreio + numero
// de serie + transportadora. Replica o comportamento da intranet antiga
// (PHP Coyote) que escrevia direto na tabela.
//
// Body: { expedicao: 'YYYY-MM-DD' (obrigatorio), rastreio: 'string' (opcional) }
//
// Comportamento idempotente: se ja existe row em SZ1010 pra esse (filial, doc,
// serie, item), faz UPDATE. Senao INSERT com proximo R_E_C_N_O_.
//
// Auditoria CRITICO (escrita em ERP).
// Permissao 12001 (Expedicao).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([12001]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// 'YYYY-MM-DD' -> 'YYYYMMDD' (formato Protheus)
const toProtDate = (iso) => {
  const s = String(iso || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

module.exports = (app) => ({
  verb: 'post',
  route: '/expedir/:doc/:serie',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const user = req.user && req.user[0];
    const doc   = trim(req.params.doc);
    const serie = trim(req.params.serie);
    const b = req.body || {};

    const dtExpedic = toProtDate(b.expedicao);
    const rastreio  = trim(b.rastreio);

    if (!doc || !serie) {
      return res.status(400).json({ message: 'doc e serie sao obrigatorios na URL.' });
    }
    if (!dtExpedic) {
      return res.status(400).json({ message: 'expedicao obrigatoria (formato YYYY-MM-DD).' });
    }

    try {
      // 1) Carrega dados da NF (precisamos do cliente/transp/emissao pra gravar nos itens da Z1)
      const nfRows = await Protheus.connectAndQuery(`
        SELECT TOP 1
               RTRIM(f2.F2_DOC)      doc,
               RTRIM(f2.F2_SERIE)    serie,
               RTRIM(f2.F2_FILIAL)   filial,
               RTRIM(f2.F2_CLIENTE)  cliente,
               RTRIM(f2.F2_LOJA)     loja,
               f2.F2_EMISSAO         emissao,
               RTRIM(f2.F2_TRANSP)   transp
          FROM SF2010 f2 WITH (NOLOCK)
         WHERE f2.D_E_L_E_T_ <> '*'
           AND f2.F2_FILIAL = '01'
           AND f2.F2_DOC   = @doc
           AND f2.F2_SERIE = @serie`,
        { doc, serie }
      );
      if (!nfRows.length) {
        return res.status(404).json({ message: `NF ${doc}/${serie} nao encontrada.` });
      }
      const nf = nfRows[0];

      // 2) Carrega itens
      const itens = await Protheus.connectAndQuery(`
        SELECT RTRIM(sd2.D2_ITEM)    item,
               RTRIM(sd2.D2_COD)     cod,
               sd2.D2_QUANT          quant,
               RTRIM(sd2.D2_PEDIDO)  pedido,
               RTRIM(sd2.D2_ZNUMSER) znumser
          FROM SD2010 sd2 WITH (NOLOCK)
         WHERE sd2.D_E_L_E_T_ <> '*'
           AND sd2.D2_FILIAL = '01'
           AND sd2.D2_DOC    = @doc
           AND sd2.D2_SERIE  = @serie
         ORDER BY sd2.D2_ITEM`,
        { doc, serie }
      );
      if (!itens.length) {
        return res.status(404).json({ message: `Sem itens em SD2 pra NF ${doc}/${serie}.` });
      }

      // 3) Pra cada item: SELECT R_E_C_N_O_ -> UPDATE ou INSERT
      const stats = { atualizados: 0, inseridos: 0, erros: 0 };
      let primeiroErro = null;   // mensagem do 1º item que falhou (surfaça ao usuário)

      // Proximo R_E_C_N_O_ pra INSERT (so consulta 1 vez, incrementa local)
      const maxRow = await Protheus.connectAndQuery(
        `SELECT ISNULL(MAX(R_E_C_N_O_), 0) maxr FROM SZ1010`, {}
      );
      let nextRecno = N(maxRow[0]?.maxr) + 1;

      for (const it of itens) {
        const item = trim(it.item);
        try {
          const exist = await Protheus.connectAndQuery(`
            SELECT TOP 1 R_E_C_N_O_ recno FROM SZ1010 WITH (NOLOCK)
             WHERE Z1_FILIAL = '01'
               AND Z1_DOC    = @doc
               AND Z1_SERIE  = @serie
               AND RTRIM(Z1_ITEM) = @item`,
            { doc, serie, item }
          );

          if (exist.length) {
            await Protheus.connectAndQuery(`
              UPDATE SZ1010 SET
                Z1_EXPEDIC = @exp,
                Z1_ENTREGA = @exp,
                Z1_RASTREI = @rast,
                Z1_ZNUMSER = @znum,
                Z1_TRANSP  = @transp
               WHERE R_E_C_N_O_ = @rec`,
              {
                exp: dtExpedic,
                rast: rastreio,
                znum: trim(it.znumser),
                transp: trim(nf.transp),
                rec: N(exist[0].recno)
              }
            );
            stats.atualizados++;
          } else {
            // R_E_C_D_E_L_ REMOVIDO (03/09/2026): a SZ1010 foi alterada no Protheus
            // e não tem mais essa coluna (ganhou Z1_ETIQ). Referenciá-la fazia
            // TODA primeira expedição de uma NF falhar ("Invalid column name
            // 'R_E_C_D_E_L_'") — só re-expedições (UPDATE) passavam.
            await Protheus.connectAndQuery(`
              INSERT INTO SZ1010 (
                Z1_FILIAL, Z1_DOC, Z1_SERIE, Z1_ITEM, Z1_PEDIDO,
                Z1_CLIENTE, Z1_LOJA, Z1_COD, Z1_QUANT, Z1_ZNUMSER,
                Z1_EMISSAO, Z1_EXPEDIC, Z1_ENTREGA, Z1_RASTREI,
                Z1_EMAIL, Z1_TRANSP, D_E_L_E_T_, R_E_C_N_O_
              ) VALUES (
                '01', @doc, @serie, @item, @pedido,
                @cliente, @loja, @cod, @quant, @znum,
                @emis, @exp, @exp, @rast,
                'N', @transp, ' ', @rec
              )`,
              {
                doc, serie, item,
                pedido:  trim(it.pedido),
                cliente: trim(nf.cliente),
                loja:    trim(nf.loja),
                cod:     trim(it.cod),
                quant:   N(it.quant),
                znum:    trim(it.znumser),
                emis:    trim(nf.emissao),
                exp:     dtExpedic,
                rast:    rastreio,
                transp:  trim(nf.transp),
                rec:     nextRecno
              }
            );
            nextRecno++;
            stats.inseridos++;
          }
        } catch (e) {
          console.error(`expedicao/expedir item ${item}:`, e.message);
          if (!primeiroErro) primeiroErro = e.message;
          stats.erros++;
        }
      }

      // 4) Auditoria
      Auditoria.registrar(app, {
        modulo: 'Expedicao', submodulo: 'ExpedirNF',
        acao: 'EXPEDIR', severidade: 'CRITICO',
        req, entidade: 'nf', entidadeId: `${doc}/${serie}`,
        descricao: `Expediu NF ${doc}/${serie} (${stats.inseridos} novos + ${stats.atualizados} atualizados, rastreio="${rastreio || '(vazio)'}")`,
        meta: {
          doc, serie,
          filial: '01',
          cliente: trim(nf.cliente), loja: trim(nf.loja),
          expedicao: dtExpedic,
          rastreio,
          ...stats
        }
      });

      // Se NENHUM item foi gravado e houve erro, isso é FALHA — não devolve 200
      // "ok:false" silencioso (o front tratava como sucesso e o usuário achava
      // que expediu). Surfaça a mensagem real do Protheus.
      if (stats.erros > 0 && stats.inseridos === 0 && stats.atualizados === 0) {
        return res.status(422).json({
          ok: false, doc, serie,
          message: `Não foi possível expedir a NF ${doc}/${serie}: ${primeiroErro || 'erro ao gravar no Protheus.'}`,
          ...stats
        });
      }

      return res.json({
        ok: stats.erros === 0,
        doc, serie,
        expedicao: dtExpedic,
        rastreio,
        // avisa se gravou parcial (alguns itens falharam)
        message: stats.erros > 0 ? `Expedido parcialmente — ${stats.erros} item(ns) falharam: ${primeiroErro || ''}` : undefined,
        ...stats
      });
    } catch (err) {
      console.error('expedicao/expedir:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
