// GET /gerencia/dre-contabil?inicio=YYYYMMDD&fim=YYYYMMDD
//
// DRE Contabil refinado — replica visualmente a planilha que a contadora
// apresenta pra diretoria ("Gnatus DRE e Razoes" em docs/). Fonte:
// CT2010 (lancamentos contabeis) + CT1010 (plano de contas).
//
// Diferenca do /gerencia/dre (modo conta):
//   - O DRE atual agrupa por LEFT(E2_CONTAD, 4) → ~10 grupos
//   - Este aqui agrupa pela CONTA COMPLETA (11 chars no Protheus, formato
//     N.N.NN.NNN.NNNN) → ~200 linhas, fiel a planilha
//   - Fonte: CT2010 (razao contabil) — inclui lancamentos de ajuste/
//     provisao mensal que a contadora faz e SE2/SF2 nao tem
//
// Convencao de SINAL (espelhada da planilha):
//   Receita (3.x)        saldo CREDOR → valor NEGATIVO
//   Custo/Despesa (4.x)  saldo DEVEDOR → valor POSITIVO
//   Lucro liquido        somando tudo, fica NEGATIVO quando ha lucro
//
// Roda 2x as queries (periodo + mesmo periodo ano anterior) pra YoY (AH%).
//
// Permissao 10001 (mesma do DRE Gerencial).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// ============== Blocos totalizadores ==============
// Estrutura da planilha da contadora (validada com a aba "DRE 2026" do
// arquivo "Gnatus DRE e Razoes - Abril 2026.xlsx"). A ordem dos blocos
// aqui define a posicao no DRE.
//
// Cada bloco tem:
//   prefix:     array de prefixos do CT1_CONTA (sem pontos) que caem nesse bloco
//   excludePrefix: prefixos a EXCLUIR mesmo se o prefix bater (ex: 4.1.10.005
//                  bate "411" mas vai pra DEPRECIACOES, nao DESP_OP)
//   derivado:   array de outros bloco-ids cuja soma forma esse bloco
//   totalizador: true = soma de folhas com `prefix`
//
// IMPORTANTE: depreciacoes (4.1.10.005) e amortizacoes (4.1.10.006) tem bloco
// proprio (apos EBITDA, junto com financeiro) — nao entram em DESP_OP.
const BLOCOS = [
  { id: 'RECEITAS',          label: 'RECEITAS TOTAIS',                       prefix: ['311'],                                            totalizador: true },
  { id: 'DEDUCOES',          label: 'DEDUÇÕES DAS RECEITAS',                 prefix: ['312'],                                            totalizador: true },
  { id: 'RECEITA_LIQUIDA',   label: 'RECEITA LÍQUIDA',                       derivado: ['RECEITAS', 'DEDUCOES'] },
  { id: 'CUSTO',             label: 'CUSTO TOTAL',                           prefix: ['32'],                                             totalizador: true },
  { id: 'LUCRO_BRUTO',       label: 'LUCRO BRUTO (Margem de Contribuição)',  derivado: ['RECEITA_LIQUIDA', 'CUSTO'] },
  // '515' captura a folha de PRODUCAO (5.1.50.001). '51550002' = Materiais Indiretos
  // e CUSTO (absorvido no CMV pela contadora) — fica de fora das despesas p/ nao
  // duplicar com o CMV (mesma logica do exclude de materia-prima no /dre).
  { id: 'DESP_OP',           label: 'DESPESAS OPERACIONAIS',                 prefix: ['411', '412', '413', '515'],
                              excludePrefix: ['4110005', '4110006', '4140', '4150', '5150002'],                                          totalizador: true },
  { id: 'EBITDA',            label: 'RESULTADO OPERACIONAL (EBITDA)',        derivado: ['LUCRO_BRUTO', 'DESP_OP'] },
  { id: 'RES_FINANCEIRO',    label: 'RECEITAS/DESPESAS FINANCEIRAS',         prefix: ['4140', '4150'],                                    totalizador: true },
  { id: 'DEPRECIACAO',       label: 'DEPRECIAÇÕES / AMORTIZAÇÕES',           prefix: ['4110005', '4110006'],                              totalizador: true },
  { id: 'RES_ANTES_IR',      label: 'RESULTADO ANTES DO IRPJ E CSLL',        derivado: ['EBITDA', 'RES_FINANCEIRO', 'DEPRECIACAO'] },
  { id: 'IRPJ_CSLL',         label: 'IRPJ / CSL — Lucro Real',               prefix: ['416', '417'],                                      totalizador: true },
  { id: 'LUCRO_LIQUIDO',     label: 'RESULTADO DO PERÍODO',                  derivado: ['RES_ANTES_IR', 'IRPJ_CSLL'] }
];

function blocoDaConta(codigo) {
  const c = trim(codigo).replace(/\D/g, '');
  for (const b of BLOCOS) {
    if (!b.prefix) continue;
    const excl = b.excludePrefix || [];
    if (excl.some(p => c.startsWith(p))) continue;
    for (const p of b.prefix) {
      if (c.startsWith(p)) return b.id;
    }
  }
  return null;   // conta nao classificada — ignorada no DRE
}

// Formata codigo Protheus (sem pontos) pra apresentacao tipo "3.1.10.001.0001".
// Plano Gnatus: 1.1.NN.NNN.NNNN (1+1+2+3+4 = 11 chars).
function formatarCodigo(c) {
  const s = trim(c).replace(/\D/g, '');
  if (s.length !== 11) return s;
  return `${s.slice(0, 1)}.${s.slice(1, 2)}.${s.slice(2, 4)}.${s.slice(4, 7)}.${s.slice(7, 11)}`;
}

// YYYYMMDD - 1 ano
function minus1Year(ymd) {
  const s = trim(ymd).replace(/\D/g, '');
  if (s.length !== 8) return ymd;
  const y = +s.slice(0, 4) - 1, m = s.slice(4, 6), d = s.slice(6, 8);
  return `${y}${m}${d}`;
}

// Variacao horizontal: (atual - anterior) / |anterior|. anterior=0 → null
function ah(atual, anterior) {
  if (!anterior) return null;
  return (atual - anterior) / Math.abs(anterior);
}

// ============== Carrega CT2010 (saldo por conta no periodo) ==============
async function carregarSaldos(Protheus, inicio, fim) {
  // Saldo de uma conta = SUM(CT2_VALOR onde DEBITO=conta) - SUM(CT2_VALOR onde CREDIT=conta)
  // → resultado positivo = conta devedora, negativo = credora.
  // Filtra apenas contas de DRE (prefixo 3/4/5) — 1/2 sao Ativo/Passivo.
  const sql = `
    SELECT conta, SUM(valor) saldo
      FROM (
        SELECT RTRIM(CT2_DEBITO) conta, CT2_VALOR valor
          FROM CT2010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'   -- consolida TODAS as filiais (01+02...), igual ao DRE da contadora
           AND CT2_DATA BETWEEN @inicio AND @fim
           AND LEFT(RTRIM(CT2_DEBITO), 1) IN ('3','4','5')
        UNION ALL
        SELECT RTRIM(CT2_CREDIT) conta, -CT2_VALOR valor
          FROM CT2010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'   -- consolida TODAS as filiais (01+02...), igual ao DRE da contadora
           AND CT2_DATA BETWEEN @inicio AND @fim
           AND LEFT(RTRIM(CT2_CREDIT), 1) IN ('3','4','5')
      ) t
     GROUP BY conta`;
  const rows = await Protheus.connectAndQuery(sql, { inicio, fim });
  const map = new Map();
  rows.forEach(r => map.set(trim(r.conta), N(r.saldo)));
  return map;
}

// Plano de contas CT1010 — descricao + flag analitica vs sintetica.
// Convencao Gnatus: CT1_CLASSE='1' (sintetica) ou '2' (analitica/folha).
// CT1_NORMAL sempre '1' — nao serve pra distinguir.
async function carregarPlanoContas(Protheus) {
  const rows = await Protheus.connectAndQuery(`
    SELECT RTRIM(CT1_CONTA) conta, RTRIM(CT1_DESC01) descricao,
           RTRIM(CT1_CLASSE) classe
      FROM CT1010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*'
       AND LEFT(RTRIM(CT1_CONTA), 1) IN ('3','4','5')`);
  const map = new Map();
  rows.forEach(r => map.set(trim(r.conta), {
    descricao: trim(r.descricao),
    analitica: trim(r.classe) === '2'   // 1=sintetica (totalizador), 2=analitica (folha)
  }));
  return map;
}

// Monta o DRE pra um periodo (saldos + plano de contas + blocos totalizadores).
function montarDre(saldos, plano) {
  // Agrega por bloco + cria array ordenado de folhas dentro de cada bloco.
  const folhasPorBloco = new Map();   // blocoId -> [{ codigo, codigoFmt, descricao, valor }]
  const totalPorBloco = new Map();    // blocoId -> total

  saldos.forEach((valor, conta) => {
    const bid = blocoDaConta(conta);
    if (!bid) return;
    const info = plano.get(conta) || { descricao: '(sem descrição)', analitica: true };
    if (!info.analitica) return;       // ignora linhas sinteticas — quem soma é o totalizador
    if (Math.abs(valor) < 0.005) return; // ignora valor zero

    if (!folhasPorBloco.has(bid)) folhasPorBloco.set(bid, []);
    folhasPorBloco.get(bid).push({
      codigo: conta,
      codigoFmt: formatarCodigo(conta),
      descricao: info.descricao,
      valor
    });
    totalPorBloco.set(bid, (totalPorBloco.get(bid) || 0) + valor);
  });

  // Ordena folhas dentro de cada bloco pelo codigo
  folhasPorBloco.forEach(arr => arr.sort((a, b) => a.codigo.localeCompare(b.codigo)));

  // Calcula derivados (RECEITA_LIQUIDA, LUCRO_BRUTO, EBITDA, etc.)
  const derivados = {};
  BLOCOS.forEach(b => {
    if (b.derivado) {
      derivados[b.id] = b.derivado.reduce((acc, srcId) => {
        return acc + (totalPorBloco.get(srcId) || derivados[srcId] || 0);
      }, 0);
    }
  });

  // Monta linhas finais
  const linhas = [];
  BLOCOS.forEach(b => {
    if (b.totalizador) {
      const folhas = folhasPorBloco.get(b.id) || [];
      folhas.forEach(f => linhas.push({
        tipo: 'folha', bloco: b.id, codigo: f.codigo, codigoFmt: f.codigoFmt,
        descricao: f.descricao, valor: f.valor
      }));
      // Totalizador depois das folhas
      linhas.push({
        tipo: 'totalizador', bloco: b.id, codigo: '', codigoFmt: '',
        descricao: b.label, valor: totalPorBloco.get(b.id) || 0
      });
    } else if (b.derivado) {
      linhas.push({
        tipo: 'derivado', bloco: b.id, codigo: '', codigoFmt: '',
        descricao: b.label, valor: derivados[b.id] || 0
      });
    }
  });

  return { linhas, totaisPorBloco: Object.fromEntries(totalPorBloco), derivados };
}

// ============== Endpoint ==============
module.exports = (app) => ({
  verb: 'get',
  route: '/dre-contabil',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const inicio = trim(req.query.inicio);
    const fim = trim(req.query.fim);
    if (!/^\d{8}$/.test(inicio) || !/^\d{8}$/.test(fim)) {
      return res.status(400).json({ message: 'Parametros inicio/fim devem ser YYYYMMDD.' });
    }
    if (inicio > fim) {
      return res.status(400).json({ message: 'inicio precisa ser <= fim.' });
    }

    const t0 = Date.now();
    const inicioAnt = minus1Year(inicio);
    const fimAnt = minus1Year(fim);

    try {
      const { Protheus } = app.services;

      // Carrega plano de contas 1x (mesmo pros dois periodos)
      const plano = await carregarPlanoContas(Protheus);

      const [saldosAtual, saldosAnterior] = await Promise.all([
        carregarSaldos(Protheus, inicio, fim),
        carregarSaldos(Protheus, inicioAnt, fimAnt)
      ]);

      const dreAtual = montarDre(saldosAtual, plano);
      const dreAnterior = montarDre(saldosAnterior, plano);

      // Cruzando: pra cada linha do periodo atual, busca o valor do anterior
      // pela mesma chave (codigo da folha OU bloco do totalizador/derivado).
      const valorAnteriorPorChave = new Map();
      dreAnterior.linhas.forEach(l => {
        const key = l.tipo === 'folha' ? l.codigo : `__${l.bloco}`;
        valorAnteriorPorChave.set(key, l.valor);
      });

      const linhas = dreAtual.linhas.map(l => {
        const key = l.tipo === 'folha' ? l.codigo : `__${l.bloco}`;
        const valorAnt = valorAnteriorPorChave.get(key) || 0;
        return {
          ...l,
          valorAnterior: valorAnt,
          ahPct: ah(l.valor, valorAnt)
        };
      });

      // Linhas que existem so no periodo anterior (ex.: conta encerrada agora)
      const codigosAtuais = new Set(dreAtual.linhas.filter(l => l.tipo === 'folha').map(l => l.codigo));
      dreAnterior.linhas.forEach(l => {
        if (l.tipo !== 'folha') return;
        if (codigosAtuais.has(l.codigo)) return;
        // Insere no fim do bloco correspondente
        const idx = linhas.findIndex(x => x.bloco === l.bloco && x.tipo === 'totalizador');
        const linhaExtra = {
          ...l, valor: 0, valorAnterior: l.valor, ahPct: -1
        };
        if (idx > 0) linhas.splice(idx, 0, linhaExtra);
        else linhas.push(linhaExtra);
      });

      // Receita Bruta usada como base do AV% (analise vertical). Convencao da
      // planilha: AV% = valor / receita_bruta (em modulo, pra ficar positivo).
      const receitaBrutaAtual = Math.abs(dreAtual.totaisPorBloco.RECEITAS || 0);
      linhas.forEach(l => {
        l.avPct = receitaBrutaAtual ? l.valor / receitaBrutaAtual : null;
      });

      return res.json({
        periodo: { inicio, fim },
        periodoAnterior: { inicio: inicioAnt, fim: fimAnt },
        linhas,
        resumo: {
          receitasTotais: dreAtual.totaisPorBloco.RECEITAS || 0,
          deducoes: dreAtual.totaisPorBloco.DEDUCOES || 0,
          receitaLiquida: dreAtual.derivados.RECEITA_LIQUIDA || 0,
          custoTotal: dreAtual.totaisPorBloco.CUSTO || 0,
          lucroBruto: dreAtual.derivados.LUCRO_BRUTO || 0,
          despesasOperacionais: dreAtual.totaisPorBloco.DESP_OP || 0,
          ebitda: dreAtual.derivados.EBITDA || 0,
          resultadoFinanceiro: dreAtual.totaisPorBloco.DESP_FINANC || 0,
          irpjCsll: dreAtual.totaisPorBloco.IRPJ_CSLL || 0,
          lucroLiquido: dreAtual.derivados.LUCRO_LIQUIDO || 0
        },
        resumoAnterior: {
          receitasTotais: dreAnterior.totaisPorBloco.RECEITAS || 0,
          ebitda: dreAnterior.derivados.EBITDA || 0,
          lucroLiquido: dreAnterior.derivados.LUCRO_LIQUIDO || 0
        },
        latenciaMs: Date.now() - t0,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('dre-contabil:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
