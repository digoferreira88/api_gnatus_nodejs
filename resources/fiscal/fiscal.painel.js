// GET /fiscal/painel?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&tipoMov=&cfop=&tes=&especie=
// Painel Fiscal — Visão Geral de Documentos (entradas/saídas, TODOS os tipos:
// NF, SPED, CTe, NFS, NFSC, etc.) + Painel Tributário. Fonte: SFT010 (livro
// fiscal), que consolida CFOP/TES/espécie/impostos por item. Período: saídas
// pela EMISSÃO, entradas pela ENTRADA (lógica de apuração). Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const toProtheusDate = (iso) => { const s = String(iso || '').replace(/-/g, '').slice(0, 8); return /^\d{8}$/.test(s) ? s : null; };

// impostos: coluna SFT + rótulo + categoria.
//  - 'apuracao': crédito (entrada) x débito (saída), saldo = débito - crédito.
//  - 'retencao': valor RETIDO na entrada (Gnatus tomador) p/ recolher depois —
//    NÃO é crédito. CSLL/PIS/COFINS retidos ficam em FT_VRET*; IRRF/INSS em FT_VAL*.
//    (ISS não é valorado na SFT010 — fica no módulo de serviços/NFS-e.)
const IMPOSTOS = [
  ['FT_VALICM', 'ICMS', 'apuracao'], ['FT_VALTST', 'ICMS-ST', 'apuracao'], ['FT_VALIPI', 'IPI', 'apuracao'],
  ['FT_DIFAL', 'DIFAL', 'apuracao'], ['FT_VALFECP', 'FCP', 'apuracao'], ['FT_ICMSRET', 'ICMS Retido (ST)', 'apuracao'],
  ['FT_VALPIS', 'PIS', 'apuracao'], ['FT_VALCOF', 'COFINS', 'apuracao'],
  ['FT_VALIRR', 'IRRF', 'retencao'], ['FT_VALINS', 'INSS', 'retencao'], ['FT_VRETCSL', 'CSLL', 'retencao'],
  ['FT_VRETPIS', 'PIS Retido', 'retencao'], ['FT_VRETCOF', 'COFINS Retido', 'retencao']
];

module.exports = (app) => ({
  verb: 'get',
  route: '/painel',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const ini = toProtheusDate(req.query.inicio), fim = toProtheusDate(req.query.fim);
    if (!ini || !fim) return res.status(400).json({ message: 'inicio e fim são obrigatórios (YYYY-MM-DD).' });

    const params = { ini, fim };
    // período: saída pela emissão, entrada pela entrada
    const conds = [`((FT_TIPOMOV='S' AND FT_EMISSAO BETWEEN @ini AND @fim) OR (FT_TIPOMOV='E' AND FT_ENTRADA BETWEEN @ini AND @fim))`];
    if (trim(req.query.tipoMov)) { conds.push(`FT_TIPOMOV=@tipoMov`); params.tipoMov = trim(req.query.tipoMov).toUpperCase(); }
    if (trim(req.query.cfop)) { conds.push(`RTRIM(FT_CFOP)=@cfop`); params.cfop = trim(req.query.cfop); }
    if (trim(req.query.tes)) { conds.push(`RTRIM(FT_TES)=@tes`); params.tes = trim(req.query.tes); }
    if (trim(req.query.especie)) { conds.push(`RTRIM(FT_ESPECIE)=@especie`); params.especie = trim(req.query.especie); }
    const WHERE = `WHERE D_E_L_E_T_<>'*' AND FT_FILIAL='01' AND ${conds.join(' AND ')}`;
    const FROM = `FROM SFT010 WITH (NOLOCK) ${WHERE}`;
    const DOCKEY = `RTRIM(FT_ESPECIE)+'|'+RTRIM(FT_SERIE)+'|'+RTRIM(FT_NFISCAL)`;
    const DATA = `CASE WHEN FT_TIPOMOV='S' THEN FT_EMISSAO ELSE FT_ENTRADA END`;
    const somaImpostos = IMPOSTOS.map(([c]) => `SUM(${c}) ${c}`).join(', ');

    try {
      const [resumo, porEspecie, porCFOP, porTES, porDia, impRows, detalhe] = await Promise.all([
        Protheus.connectAndQuery(`SELECT FT_TIPOMOV tipo, COUNT(DISTINCT ${DOCKEY}) docs, COUNT(*) itens, SUM(FT_VALCONT) valor ${FROM} GROUP BY FT_TIPOMOV`, params),
        Protheus.connectAndQuery(`SELECT FT_TIPOMOV tipo, RTRIM(FT_ESPECIE) especie, COUNT(DISTINCT ${DOCKEY}) docs, COUNT(*) itens, SUM(FT_VALCONT) valor ${FROM} GROUP BY FT_TIPOMOV, RTRIM(FT_ESPECIE) ORDER BY SUM(FT_VALCONT) DESC`, params),
        Protheus.connectAndQuery(`SELECT FT_TIPOMOV tipo, RTRIM(FT_CFOP) cfop, COUNT(*) itens, SUM(FT_VALCONT) valor ${FROM} GROUP BY FT_TIPOMOV, RTRIM(FT_CFOP) ORDER BY SUM(FT_VALCONT) DESC`, params),
        Protheus.connectAndQuery(`SELECT FT_TIPOMOV tipo, RTRIM(FT_TES) tes, COUNT(*) itens, SUM(FT_VALCONT) valor ${FROM} GROUP BY FT_TIPOMOV, RTRIM(FT_TES) ORDER BY SUM(FT_VALCONT) DESC`, params),
        Protheus.connectAndQuery(`SELECT ${DATA} dia, FT_TIPOMOV tipo, SUM(FT_VALCONT) valor ${FROM} GROUP BY ${DATA}, FT_TIPOMOV ORDER BY ${DATA}`, params),
        Protheus.connectAndQuery(`SELECT FT_TIPOMOV tipo, ${somaImpostos} ${FROM} GROUP BY FT_TIPOMOV`, params),
        Protheus.connectAndQuery(`SELECT TOP 10000 FT_TIPOMOV tipo, RTRIM(FT_ESPECIE) especie, RTRIM(FT_SERIE) serie, RTRIM(FT_NFISCAL) doc, ${DATA} data, RTRIM(FT_CFOP) cfop, RTRIM(FT_TES) tes, RTRIM(FT_CLIDEST) cliente, RTRIM(FT_ESTADO) uf, FT_VALCONT valor, FT_BASEICM baseIcm, FT_VALICM icms, FT_VALTST icmsSt, FT_VALIPI ipi, FT_DIFAL difal, FT_VALFECP fcp, FT_ICMSRET icmsRet, FT_VALPIS pis, FT_VALCOF cofins ${FROM} ORDER BY ${DATA} DESC, FT_NFISCAL`, params)
      ]);

      const cell = (r) => ({ docs: N(r && r.docs), itens: N(r && r.itens), valor: +N(r && r.valor).toFixed(2) });
      const resumoOut = {
        entrada: cell(resumo.find(r => trim(r.tipo) === 'E')),
        saida: cell(resumo.find(r => trim(r.tipo) === 'S'))
      };

      // impostos: entrada vs saída + saldo (saída - entrada)
      const impE = impRows.find(r => trim(r.tipo) === 'E') || {};
      const impS = impRows.find(r => trim(r.tipo) === 'S') || {};
      const impostos = IMPOSTOS.map(([col, nome, categoria]) => {
        const entrada = +N(impE[col]).toFixed(2), saida = +N(impS[col]).toFixed(2);
        // apuração: saldo = débito(saída) - crédito(entrada). retenção: retido = total a recolher.
        return { nome, categoria, entrada, saida, saldo: +(saida - entrada).toFixed(2), retido: +(entrada + saida).toFixed(2) };
      });

      // filtros disponíveis no período (universo sem o filtro específico aplicado — aqui simplificado: do resultado)
      const uniq = (rows, key) => [...new Set(rows.map(r => trim(r[key])).filter(Boolean))].sort();

      return res.json({
        periodo: { inicio: ini, fim },
        resumo: resumoOut,
        porEspecie: porEspecie.map(r => ({ tipo: trim(r.tipo), especie: trim(r.especie) || '(sem)', docs: N(r.docs), itens: N(r.itens), valor: +N(r.valor).toFixed(2) })),
        porCFOP: porCFOP.map(r => ({ tipo: trim(r.tipo), cfop: trim(r.cfop) || '(sem)', itens: N(r.itens), valor: +N(r.valor).toFixed(2) })),
        porTES: porTES.map(r => ({ tipo: trim(r.tipo), tes: trim(r.tes) || '(sem)', itens: N(r.itens), valor: +N(r.valor).toFixed(2) })),
        porDia: porDia.map(r => ({ dia: trim(r.dia), tipo: trim(r.tipo), valor: +N(r.valor).toFixed(2) })),
        impostos,
        filtrosDisponiveis: { cfops: uniq(porCFOP, 'cfop'), tes: uniq(porTES, 'tes'), especies: uniq(porEspecie, 'especie') },
        detalhe: detalhe.map(r => ({
          tipo: trim(r.tipo), especie: trim(r.especie), serie: trim(r.serie), doc: trim(r.doc), data: trim(r.data),
          cfop: trim(r.cfop), tes: trim(r.tes), cliente: trim(r.cliente), uf: trim(r.uf),
          valor: +N(r.valor).toFixed(2), baseIcm: +N(r.baseIcm).toFixed(2), icms: +N(r.icms).toFixed(2), icmsSt: +N(r.icmsSt).toFixed(2),
          ipi: +N(r.ipi).toFixed(2), difal: +N(r.difal).toFixed(2), fcp: +N(r.fcp).toFixed(2), icmsRet: +N(r.icmsRet).toFixed(2),
          pis: +N(r.pis).toFixed(2), cofins: +N(r.cofins).toFixed(2)
        })),
        geradoEm: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro fiscal/painel:', error);
      return res.status(500).json({ message: 'Erro ao gerar painel fiscal: ' + error.message });
    }
  }
});
