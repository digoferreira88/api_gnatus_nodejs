// GET /controladoria/poder-terceiros/retornos
// Em quais NFs voltou o saldo de cada remessa em poder de terceiros.
//
// Como o Protheus grava (conferido 26/10/2026):
//   - remessa: SB6010 com B6_PODER3='R' (a mesma linha do espelho)
//   - cada retorno: OUTRA linha na SB6010 com B6_PODER3='D' e o MESMO B6_IDENT
//     da remessa; B6_DOC/B6_SERIE = NF de entrada do retorno, B6_QUANT = qtd devolvida
//   - o item da NF de entrada (SD1010) aponta pra remessa por D1_IDENTB6 — de lá vem
//     o CFOP real (1902, 2909...) e a chave da NF-e (SF1010)
//   - enviado − saldo = soma dos retornos em 100% das remessas
//
// Traz toda remessa (TES da lista do Fiscal) que teve pelo menos 1 retorno:
// as que ainda têm saldo (PARCIAL) e as que voltaram inteiras (TOTAL).
// Permissão 11003.

const { trim, toN, categoriaFromTes, inTesSql, protheusDateToISO } = require('./_ptTes');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

const r4 = (n) => Number(n.toFixed(4));
const r2 = (n) => Number(n.toFixed(2));

module.exports = (app) => ({
  verb: 'get',
  route: '/poder-terceiros/retornos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;

    try {
      // 1 linha por NF de retorno, com os dados da remessa repetidos.
      // OUTER APPLY TOP 1 no SD1: a mesma NF pode ter 2 itens pro mesmo IDENT
      // (acontece em 2 casos) — sem o TOP 1 a linha de retorno duplicaria.
      const rows = await Protheus.connectAndQuery(
        `SELECT RTRIM(r.B6_IDENT)   ident,
                RTRIM(r.B6_PRODUTO) produto,
                RTRIM(sb1.B1_DESC)  produtoDesc,
                RTRIM(sb1.B1_TIPO)  produtoTipo,
                RTRIM(sb1.B1_UM)    um,
                RTRIM(r.B6_CLIFOR)  codClifor,
                RTRIM(r.B6_LOJA)    loja,
                RTRIM(r.B6_TPCF)    tpcf,
                COALESCE(RTRIM(sa1.A1_NOME), RTRIM(sa2.A2_NOME), '') terceiroNome,
                COALESCE(RTRIM(sa1.A1_MUN),  RTRIM(sa2.A2_MUN),  '') terceiroMun,
                COALESCE(RTRIM(sa1.A1_EST),  RTRIM(sa2.A2_EST),  '') terceiroUf,
                RTRIM(r.B6_DOC)     nf,
                RTRIM(r.B6_SERIE)   serie,
                r.B6_EMISSAO        emissao,
                r.B6_QUANT          qtRemetida,
                r.B6_SALDO          saldo,
                r.B6_PRUNIT         prunit,
                RTRIM(r.B6_TES)     tes,
                RTRIM(f4r.F4_TEXTO) tesDesc,
                RTRIM(r.B6_LOCAL)   armazem,
                RTRIM(d.B6_DOC)     retNf,
                RTRIM(d.B6_SERIE)   retSerie,
                d.B6_EMISSAO        retEmissao,
                d.B6_DTDIGIT        retDigitacao,
                d.B6_QUANT          retQuant,
                RTRIM(d.B6_TES)     retTes,
                RTRIM(f4d.F4_TEXTO) retTesDesc,
                RTRIM(f4d.F4_CF)    retTesCf,
                sd1.cfop            retCfop,
                sd1.chave           retChave,
                d.R_E_C_N_O_        retRecno
           FROM SB6010 r WITH (NOLOCK)
           JOIN SB6010 d WITH (NOLOCK)
             ON d.B6_FILIAL = r.B6_FILIAL AND d.B6_IDENT = r.B6_IDENT
            AND d.B6_PODER3 = 'D' AND d.D_E_L_E_T_ <> '*'
           LEFT JOIN SF4010 f4r WITH (NOLOCK)
             ON f4r.F4_FILIAL = '01' AND f4r.F4_CODIGO = r.B6_TES AND f4r.D_E_L_E_T_ <> '*'
           LEFT JOIN SF4010 f4d WITH (NOLOCK)
             ON f4d.F4_FILIAL = '01' AND f4d.F4_CODIGO = d.B6_TES AND f4d.D_E_L_E_T_ <> '*'
           LEFT JOIN SB1010 sb1 WITH (NOLOCK)
             ON sb1.B1_COD = r.B6_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
           LEFT JOIN SA1010 sa1 WITH (NOLOCK)
             ON r.B6_TPCF = 'C' AND sa1.A1_COD = r.B6_CLIFOR AND sa1.A1_LOJA = r.B6_LOJA AND sa1.D_E_L_E_T_ <> '*'
           LEFT JOIN SA2010 sa2 WITH (NOLOCK)
             ON r.B6_TPCF = 'F' AND sa2.A2_COD = r.B6_CLIFOR AND sa2.A2_LOJA = r.B6_LOJA AND sa2.D_E_L_E_T_ <> '*'
          OUTER APPLY (
                SELECT TOP 1 RTRIM(d1.D1_CF) cfop, RTRIM(f1.F1_CHVNFE) chave
                  FROM SD1010 d1 WITH (NOLOCK)
                  LEFT JOIN SF1010 f1 WITH (NOLOCK)
                    ON f1.F1_FILIAL = d1.D1_FILIAL AND f1.F1_DOC = d1.D1_DOC AND f1.F1_SERIE = d1.D1_SERIE
                   AND f1.F1_FORNECE = d1.D1_FORNECE AND f1.F1_LOJA = d1.D1_LOJA AND f1.D_E_L_E_T_ <> '*'
                 WHERE d1.D1_FILIAL = d.B6_FILIAL AND d1.D1_IDENTB6 = d.B6_IDENT
                   AND d1.D1_DOC = d.B6_DOC AND d1.D1_SERIE = d.B6_SERIE
                   AND d1.D1_FORNECE = d.B6_CLIFOR AND d1.D1_LOJA = d.B6_LOJA
                   AND d1.D_E_L_E_T_ <> '*'
               ) sd1
          WHERE r.D_E_L_E_T_ <> '*'
            AND r.B6_FILIAL = '01'
            AND r.B6_TIPO = 'E'
            AND r.B6_PODER3 = 'R'
            AND RTRIM(r.B6_TES) IN (${inTesSql()})`,
        {}
      );

      // Agrupa por remessa (B6_IDENT)
      const porIdent = new Map();
      for (const row of rows) {
        const categoria = categoriaFromTes(row.tes);
        if (!categoria) continue;
        const ident = trim(row.ident);
        let rem = porIdent.get(ident);
        if (!rem) {
          rem = {
            ident,
            produto: trim(row.produto),
            produtoDesc: trim(row.produtoDesc),
            produtoTipo: trim(row.produtoTipo),
            um: trim(row.um),
            codClifor: trim(row.codClifor),
            loja: trim(row.loja),
            tipoTerceiro: trim(row.tpcf) === 'F' ? 'Fornecedor' : 'Cliente',
            terceiroNome: trim(row.terceiroNome) || `(${trim(row.codClifor)}/${trim(row.loja)})`,
            terceiroLocalidade: [trim(row.terceiroMun), trim(row.terceiroUf)].filter(Boolean).join(' / '),
            nf: trim(row.nf),
            serie: trim(row.serie),
            emissao: protheusDateToISO(row.emissao),
            tes: trim(row.tes),
            tesDesc: trim(row.tesDesc),
            categoria,
            armazem: trim(row.armazem),
            prunit: toN(row.prunit),
            qtRemetida: toN(row.qtRemetida),
            saldo: toN(row.saldo),
            retornos: []
          };
          porIdent.set(ident, rem);
        }
        rem.retornos.push({
          nf: trim(row.retNf),
          serie: trim(row.retSerie),
          emissao: protheusDateToISO(row.retEmissao),
          digitacao: protheusDateToISO(row.retDigitacao),
          quantidade: toN(row.retQuant),
          tes: trim(row.retTes),
          tesDesc: trim(row.retTesDesc),
          cfop: trim(row.retCfop) || trim(row.retTesCf),
          chave: trim(row.retChave),
          recno: Number(row.retRecno) || 0
        });
      }

      // Ordem cronológica dos retornos (emissão, depois digitação) + saldo após cada um
      const remessas = [...porIdent.values()].map(rem => {
        rem.retornos.sort((a, b) =>
          (a.emissao || '').localeCompare(b.emissao || '') ||
          (a.digitacao || '').localeCompare(b.digitacao || '') ||
          a.recno - b.recno);
        let acumulado = 0;
        rem.retornos = rem.retornos.map(({ recno, ...ret }) => {
          acumulado += ret.quantidade;
          return {
            ...ret,
            quantidade: r4(ret.quantidade),
            valor: r2(ret.quantidade * rem.prunit),
            saldoApos: r4(Math.max(0, rem.qtRemetida - acumulado))
          };
        });
        const qtRetornada = r4(acumulado);
        const ultimo = rem.retornos.reduce((m, r) => (r.emissao > m ? r.emissao : m), '');
        return {
          ...rem,
          qtRetornada,
          valorRetornado: r2(qtRetornada * rem.prunit),
          valorSaldo: r2(rem.saldo * rem.prunit),
          situacao: rem.saldo > 0 ? 'PARCIAL' : 'TOTAL',
          qtNfsRetorno: rem.retornos.length,
          ultimoRetorno: ultimo || null,
          // Se um dia não fechar (ajuste manual no SB6?), a tela avisa em vez de esconder
          divergencia: r4(rem.qtRemetida - rem.saldo - acumulado)
        };
      }).sort((a, b) => (b.ultimoRetorno || '').localeCompare(a.ultimoRetorno || ''));

      const nfsDistintas = new Set();
      remessas.forEach(r => r.retornos.forEach(x => nfsDistintas.add(`${x.nf}|${x.serie}|${r.codClifor}|${r.loja}`)));

      return res.json({
        totalRemessas: remessas.length,
        totalParciais: remessas.filter(r => r.situacao === 'PARCIAL').length,
        totalTotais: remessas.filter(r => r.situacao === 'TOTAL').length,
        totalNfsRetorno: nfsDistintas.size,
        totalLinhasRetorno: rows.length,
        valorRetornado: r2(remessas.reduce((s, r) => s + r.valorRetornado, 0)),
        valorSaldo: r2(remessas.reduce((s, r) => s + r.valorSaldo, 0)),
        remessas,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro poder-terceiros-retornos:', err);
      return res.status(500).json({ message: 'Erro ao consultar retornos (SB6010): ' + err.message });
    }
  }
});
