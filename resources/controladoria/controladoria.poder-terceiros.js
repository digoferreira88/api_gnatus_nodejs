// Produtos em poder de terceiros — base SB6010 (saldo do controle "poder3")
//
// Conceito (convenção Gnatus, observada nos dados):
//   B6_TIPO  = 'E'  → registros ativos de remessa (a Gnatus enviou ao terceiro)
//   B6_PODER3 = 'R' → marca poder de terceiros - Remessa
//   B6_TPCF  = 'C' (cliente) | 'F' (fornecedor)
//   B6_SALDO = quantidade ainda em poder do terceiro (após retornos)
//   Valor = SALDO × B6_PRUNIT
//
// Filtro: por TES (B6_TES / SF4.F4_CODIGO). Lista definida pelo Fiscal
// (2026-05) — ver TES_INCLUIR abaixo. CFOP fica como informacao adicional
// na linha mas nao filtra.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// TES que entram no relatorio (definidas pelo Fiscal):
//   546 (CFOP 5908/6908) → Comodato
//   544 (CFOP 5915/6915) → Conserto
//   573 (CFOP 5915/6915) → Conserto
//   563 (CFOP 5901/6901) → Industrializacao
//   656 (CFOP 5949/6949) → Teste/Desenvolvimento
const TES_INCLUIR = ['546', '544', '573', '563', '656'];
const CATEGORIA_BY_TES = {
  '546': 'Comodato',
  '544': 'Conserto',
  '573': 'Conserto',
  '563': 'Industrialização',
  '656': 'Teste/Desenvolvimento'
};
const categoriaFromTes = (tes) => CATEGORIA_BY_TES[trim(tes)] || null;

const protheusDateToISO = (s) => {
  s = String(s || '').replace(/\D/g, '');
  if (s.length !== 8) return '';
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
};
const diasDesde = (yyyymmdd) => {
  const iso = protheusDateToISO(yyyymmdd);
  if (!iso) return null;
  const dt = new Date(iso + 'T00:00:00');
  if (isNaN(dt.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 86400000));
};

module.exports = (app) => ({
  verb: 'get',
  route: '/poder-terceiros',

  handler: async (req, res) => {
    const { Protheus } = app.services;

    try {
      // SB6010 filtrada pela lista de TES definida pelo fiscal.
      // SF4010 traz a descricao e o CFOP da TES (informativo, nao filtra).
      const inTes = TES_INCLUIR.map(t => `'${t}'`).join(',');
      const rows = await Protheus.connectAndQuery(
        `SELECT RTRIM(b6.B6_PRODUTO) produto,
                RTRIM(sb1.B1_DESC)   produtoDesc,
                RTRIM(sb1.B1_TIPO)   produtoTipo,
                RTRIM(sb1.B1_UM)     um,
                RTRIM(b6.B6_CLIFOR)  codClifor,
                RTRIM(b6.B6_LOJA)    loja,
                RTRIM(b6.B6_TPCF)    tpcf,
                COALESCE(RTRIM(sa1.A1_NOME), RTRIM(sa2.A2_NOME), '') terceiroNome,
                COALESCE(RTRIM(sa1.A1_MUN),  RTRIM(sa2.A2_MUN),  '') terceiroMun,
                COALESCE(RTRIM(sa1.A1_EST),  RTRIM(sa2.A2_EST),  '') terceiroUf,
                b6.B6_SALDO          saldo,
                b6.B6_QUANT          qtRemetida,
                b6.B6_PRUNIT         prunit,
                b6.B6_EMISSAO        emissao,
                RTRIM(b6.B6_DOC)     nf,
                RTRIM(b6.B6_SERIE)   serie,
                RTRIM(b6.B6_LOCAL)   local,
                RTRIM(b6.B6_TES)     tes,
                RTRIM(sf4.F4_TEXTO)  tesDesc,
                RTRIM(sf4.F4_CF)     cfop
           FROM SB6010 b6 WITH (NOLOCK)
           LEFT JOIN SF4010 sf4 WITH (NOLOCK)
             ON sf4.F4_FILIAL = '01' AND sf4.F4_CODIGO = b6.B6_TES AND sf4.D_E_L_E_T_ <> '*'
           LEFT JOIN SB1010 sb1 WITH (NOLOCK)
             ON sb1.B1_COD = b6.B6_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
           LEFT JOIN SA1010 sa1 WITH (NOLOCK)
             ON b6.B6_TPCF = 'C' AND sa1.A1_COD = b6.B6_CLIFOR AND sa1.A1_LOJA = b6.B6_LOJA AND sa1.D_E_L_E_T_ <> '*'
           LEFT JOIN SA2010 sa2 WITH (NOLOCK)
             ON b6.B6_TPCF = 'F' AND sa2.A2_COD = b6.B6_CLIFOR AND sa2.A2_LOJA = b6.B6_LOJA AND sa2.D_E_L_E_T_ <> '*'
          WHERE b6.D_E_L_E_T_ <> '*'
            AND b6.B6_FILIAL = '01'
            AND b6.B6_SALDO > 0
            AND b6.B6_TIPO = 'E'
            AND RTRIM(b6.B6_TES) IN (${inTes})`,
        {}
      );

      // Normaliza + categoriza pela TES (descarta linhas sem categoria mapeada — defesa)
      const itens = rows.map(r => {
        const categoria = categoriaFromTes(r.tes);
        if (!categoria) return null;
        const saldo  = toN(r.saldo);
        const prunit = toN(r.prunit);
        return {
          produto: trim(r.produto),
          produtoDesc: trim(r.produtoDesc),
          produtoTipo: trim(r.produtoTipo),
          um: trim(r.um),
          codClifor: trim(r.codClifor),
          loja: trim(r.loja),
          tipoTerceiro: trim(r.tpcf) === 'F' ? 'Fornecedor' : 'Cliente',
          terceiroNome: trim(r.terceiroNome) || `(${trim(r.codClifor)}/${trim(r.loja)})`,
          terceiroLocalidade: [trim(r.terceiroMun), trim(r.terceiroUf)].filter(Boolean).join(' / '),
          saldo,
          qtRemetida: toN(r.qtRemetida),
          prunit,
          valor: saldo * prunit,
          emissao: protheusDateToISO(r.emissao),
          diasEmPoder: diasDesde(r.emissao),
          nf: trim(r.nf),
          serie: trim(r.serie),
          armazem: trim(r.local),
          tes: trim(r.tes),
          tesDesc: trim(r.tesDesc),
          cfop: trim(r.cfop),
          categoria
        };
      }).filter(Boolean);

      // Resumo por categoria
      const porCategoria = {};
      itens.forEach(i => {
        if (!porCategoria[i.categoria]) {
          porCategoria[i.categoria] = { categoria: i.categoria, qtItens: 0, qtProdutosDistintos: new Set(), qtTerceiros: new Set(), qtUnidades: 0, valor: 0 };
        }
        const c = porCategoria[i.categoria];
        c.qtItens++;
        c.qtProdutosDistintos.add(i.produto);
        c.qtTerceiros.add(`${i.codClifor}|${i.loja}`);
        c.qtUnidades += i.saldo;
        c.valor += i.valor;
      });
      const resumoCategorias = Object.values(porCategoria)
        .map(c => ({
          categoria: c.categoria,
          qtItens: c.qtItens,
          qtProdutosDistintos: c.qtProdutosDistintos.size,
          qtTerceiros: c.qtTerceiros.size,
          qtUnidades: Number(c.qtUnidades.toFixed(2)),
          valor: Number(c.valor.toFixed(2))
        }))
        .sort((a, b) => b.valor - a.valor);

      // Totais gerais
      const totalValor = itens.reduce((s, i) => s + i.valor, 0);
      const totalUnidades = itens.reduce((s, i) => s + i.saldo, 0);
      const totalTerceiros = new Set(itens.map(i => `${i.codClifor}|${i.loja}`)).size;
      const totalProdutos = new Set(itens.map(i => i.produto)).size;

      // Top terceiros (concentração)
      const porTerceiro = {};
      itens.forEach(i => {
        const k = `${i.codClifor}|${i.loja}`;
        if (!porTerceiro[k]) {
          porTerceiro[k] = { codigo: i.codClifor, loja: i.loja, nome: i.terceiroNome, tipo: i.tipoTerceiro, qtItens: 0, valor: 0 };
        }
        porTerceiro[k].qtItens++;
        porTerceiro[k].valor += i.valor;
      });
      const topTerceiros = Object.values(porTerceiro)
        .map(t => ({ ...t, valor: Number(t.valor.toFixed(2)) }))
        .sort((a, b) => b.valor - a.valor)
        .slice(0, 20);

      return res.json({
        totalItens: itens.length,
        totalProdutos,
        totalTerceiros,
        totalUnidades: Number(totalUnidades.toFixed(2)),
        totalValor: Number(totalValor.toFixed(2)),
        resumoCategorias,
        topTerceiros,
        itens,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro poder-terceiros:', err);
      return res.status(500).json({ message: 'Erro ao consultar SB6010: ' + err.message });
    }
  }
});
