// GET /home/expedicoes?periodo=hoje|mes
//
// Alimenta o GLOBO da home ("Gnatus pelo mundo") com dados REAIS de expedição:
// notas fiscais de venda (SF2 x SD2 CFOP de venda/exportação) emitidas no período,
// agrupadas por UF (SA1.A1_EST) e país (SA1.A1_PAIS). Retorna totais (estados,
// países, pedidos) + destinos ordenados + um resumo p/ o ticker.
//
// NÃO tem requirePerm: é a home de todo mundo e o dado é NÃO-sensível (contagem
// de expedições, sem R$). O front tem a tabela de coordenadas UF/país.

const trim = (v) => String(v == null ? '' : v).trim();

// CFOP de venda (mesma lista do DRE/faturamento) + exportação (7xxx) p/ pegar o
// "pelo mundo" quando houver.
const CFOPS = ['5105','5106','5116','5117','5119','5405','5933',
               '6105','6106','6107','6108','6109','6110','6116','6117','6119','6122','6123','6404','6933',
               '5907','6907','5924',
               '7101','7102','7105','7106','7127','7501','7949'];

function ymd(d){ const p = n => String(n).padStart(2,'0'); return '' + d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()); }

module.exports = (app) => ({
  verb: 'get',
  route: '/expedicoes',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const periodo = trim(req.query.periodo) === 'hoje' ? 'hoje' : 'mes';
    const hoje = new Date();
    const fim = ymd(hoje);
    const ini = periodo === 'hoje' ? fim : ymd(new Date(hoje.getFullYear(), hoje.getMonth(), 1));

    const cvKeys = CFOPS.map((_, i) => `@cv${i}`).join(',');
    const cvP = {}; CFOPS.forEach((v, i) => { cvP[`cv${i}`] = v; });

    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT RTRIM(ISNULL(sa1.A1_EST,'')) uf, RTRIM(ISNULL(sa1.A1_PAIS,'')) pais,
               COUNT(DISTINCT RTRIM(sf2.F2_DOC)+'|'+RTRIM(sf2.F2_SERIE)) notas
          FROM SF2010 sf2 WITH (NOLOCK)
          INNER JOIN SD2010 sd2 WITH (NOLOCK)
            ON sd2.D2_FILIAL=sf2.F2_FILIAL AND sd2.D2_DOC=sf2.F2_DOC AND sd2.D2_SERIE=sf2.F2_SERIE
           AND sd2.D2_CLIENTE=sf2.F2_CLIENTE AND sd2.D2_LOJA=sf2.F2_LOJA AND sd2.D_E_L_E_T_<>'*'
          INNER JOIN SA1010 sa1 WITH (NOLOCK)
            ON sa1.A1_COD=sf2.F2_CLIENTE AND sa1.A1_LOJA=sf2.F2_LOJA AND sa1.D_E_L_E_T_<>'*'
         WHERE sf2.D_E_L_E_T_<>'*' AND sf2.F2_FILIAL='01' AND sf2.F2_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(sd2.D2_CF) IN (${cvKeys})
         GROUP BY sa1.A1_EST, sa1.A1_PAIS`, { ini, fim, ...cvP });

      const ufs = new Set(), paises = new Set();
      let pedidos = 0;
      const porUf = new Map(), porPais = new Map();
      rows.forEach(r => {
        const uf = trim(r.uf), pais = trim(r.pais), n = Number(r.notas) || 0;
        pedidos += n;
        // país 105 = Brasil (ou vazio = tratamos como nacional)
        const nacional = !pais || pais === '105';
        if (nacional) { if (uf) { ufs.add(uf); porUf.set(uf, (porUf.get(uf) || 0) + n); } }
        else { paises.add(pais); porPais.set(pais, (porPais.get(pais) || 0) + n); }
        if (pais) paises.add(pais);
      });

      const destinos = [];
      porUf.forEach((count, uf) => destinos.push({ code: uf, tipo: 'UF', count, intl: false }));
      porPais.forEach((count, pais) => destinos.push({ code: pais, tipo: 'PAIS', count, intl: true }));
      destinos.sort((a, b) => b.count - a.count);

      // Ticker: últimas notas (nota + cidade/UF) p/ o rodapé animado.
      let recentes = [];
      try {
        const rc = await Protheus.connectAndQuery(`
          SELECT TOP 10 RTRIM(sf2.F2_DOC) doc, RTRIM(ISNULL(sa1.A1_MUN,'')) cidade, RTRIM(ISNULL(sa1.A1_EST,'')) uf
            FROM SF2010 sf2 WITH (NOLOCK)
            INNER JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD=sf2.F2_CLIENTE AND sa1.A1_LOJA=sf2.F2_LOJA AND sa1.D_E_L_E_T_<>'*'
           WHERE sf2.D_E_L_E_T_<>'*' AND sf2.F2_FILIAL='01' AND sf2.F2_EMISSAO BETWEEN @ini AND @fim
           ORDER BY sf2.F2_EMISSAO DESC, sf2.F2_DOC DESC`, { ini, fim });
        recentes = rc.map(r => ({ ref: trim(r.doc), destino: (trim(r.cidade) ? trim(r.cidade) : trim(r.uf)) + (trim(r.uf) ? ' · ' + trim(r.uf) : '') }))
                     .filter(r => r.ref && r.destino);
      } catch (e) { console.warn('home/expedicoes recentes:', e.message); }

      return res.json({
        periodo, inicio: ini, fim,
        totais: { estados: ufs.size, paises: paises.size, pedidos },
        destinos,
        recentes,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('home/expedicoes:', err);
      return res.status(500).json({ message: 'Erro ao carregar expedições.' });
    }
  }
});
