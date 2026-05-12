// Snapshot mensal de estoque (saldo + saidas) -> tab_estoque_snapshot_mensal.
//
// Estrategia:
//   - Roda diariamente as 03:00 (cron) e refaz o mes corrente.
//   - Inclui ate 12 meses anteriores na PRIMEIRA execucao (bootstrap), pra que
//     historico fique imediatamente disponivel.
//   - Saldo e custo medio: SB2 fotografia atual (B2_QATU, B2_CM1) por (cod, armazem).
//     -> Pra meses passados, usamos o saldo atual como proxy (Protheus nao guarda
//        snapshot historico; a alternativa seria reconstruir via SD3, fora do escopo).
//     -> Saidas mensais (qtd e valor) vem de SD2 (vendas) + SD3 (consumo de
//        producao) agregados por (cod, armazem, mes).
//
// Idempotencia: ON CONFLICT (ano_mes, cod_produto, armazem) DO UPDATE.
//
// Uso:
//   await EstoqueSnapshot.atualizar(app, { meses: 1 })  -> so o mes corrente
//   await EstoqueSnapshot.atualizar(app, { meses: 12 }) -> bootstrap

const Calc = require('./estoqueCalculo');

const CFOPS_SAIDA_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933'
];

// Tipos de movimentacao SD3 que representam CONSUMO (saida) — RE0 (requisicao
// de producao) e similares. PR0 = producao (entrada). Pra MP, focamos em RE0/RE.
// (Lista pode ser ajustada conforme padronizacao Protheus da Gnatus.)
const TIPOS_SD3_SAIDA = ['RE0', 'RE1', 'RE5'];

// Le saldo atual de SB2 (snapshot fotografico — usado pro mes corrente)
async function lerSaldoAtual(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(sb2.B2_COD)   cod_produto,
           RTRIM(sb2.B2_LOCAL) armazem,
           RTRIM(sb1.B1_TIPO)  tipo_produto,
           RTRIM(sb1.B1_DESC)  descricao,
           RTRIM(sb1.B1_GRUPO) grupo,
           sb2.B2_QATU  qtd_estoque,
           sb2.B2_CM1   custo_medio,
           sb2.B2_VATU1 valor_estoque
      FROM SB2010 sb2 WITH (NOLOCK)
      LEFT JOIN SB1010 sb1 WITH (NOLOCK)
        ON sb1.B1_COD = sb2.B2_COD AND sb1.D_E_L_E_T_ <> '*'
     WHERE sb2.D_E_L_E_T_ <> '*'
       AND sb2.B2_FILIAL = '01'`,
    {}
  );
}

// Saidas SD2 (vendas) por (cod, armazem) num mes (formato YYYYMM01..YYYYMM31).
async function lerSaidasVendas(Protheus, ymdIni, ymdFim) {
  const cfopList = CFOPS_SAIDA_VENDA.map(c => `'${c}'`).join(',');
  return Protheus.connectAndQuery(`
    SELECT RTRIM(sd2.D2_COD)   cod_produto,
           RTRIM(sd2.D2_LOCAL) armazem,
           SUM(sd2.D2_QUANT)   qtd_saidas,
           SUM(sd2.D2_TOTAL)   valor_saidas
      FROM SD2010 sd2 WITH (NOLOCK)
     WHERE sd2.D_E_L_E_T_ <> '*'
       AND sd2.D2_FILIAL = '01'
       AND sd2.D2_EMISSAO BETWEEN @ini AND @fim
       AND sd2.D2_CF IN (${cfopList})
     GROUP BY sd2.D2_COD, sd2.D2_LOCAL`,
    { ini: ymdIni, fim: ymdFim }
  );
}

// Consumo SD3 (requisicoes de producao) por (cod, armazem) num mes.
async function lerSaidasProducao(Protheus, ymdIni, ymdFim) {
  const tiposList = TIPOS_SD3_SAIDA.map(t => `'${t}'`).join(',');
  return Protheus.connectAndQuery(`
    SELECT RTRIM(sd3.D3_COD)   cod_produto,
           RTRIM(sd3.D3_LOCAL) armazem,
           SUM(sd3.D3_QUANT)   qtd_saidas,
           SUM(sd3.D3_CUSTO1)  valor_saidas
      FROM SD3010 sd3 WITH (NOLOCK)
     WHERE sd3.D_E_L_E_T_ <> '*'
       AND sd3.D3_FILIAL = '01'
       AND sd3.D3_EMISSAO BETWEEN @ini AND @fim
       AND RTRIM(sd3.D3_TM) IN (${tiposList})
     GROUP BY sd3.D3_COD, sd3.D3_LOCAL`,
    { ini: ymdIni, fim: ymdFim }
  );
}

// Calcula 1ºYYYYMM01 e ultimo dia YYYYMMDD de um anoMes 'YYYYMM'
function rangeDoMes(anoMes) {
  const ano = Number(anoMes.slice(0, 4));
  const mes = Number(anoMes.slice(4, 6));
  const ultimoDia = new Date(ano, mes, 0).getDate();
  return {
    ini: `${anoMes}01`,
    fim: `${anoMes}${String(ultimoDia).padStart(2, '0')}`
  };
}

// Atualiza snapshot pros ultimos `meses` (default 1 = so o mes corrente).
async function atualizar(app, { meses = 1 } = {}) {
  const { Pg, Protheus } = app.services;
  const inicio = Date.now();
  const stats = { iniciado_em: new Date().toISOString(), meses_processados: [] };

  // 1) Saldo atual (snapshot fotografico) -> usado em todos os meses processados.
  // Pra meses passados, eh um proxy (Protheus nao guarda saldo historico real).
  const saldo = await lerSaldoAtual(Protheus);
  console.log(`[snapshot] saldo atual lido: ${saldo.length} produtos x armazem`);

  const anosMes = Calc.ultimosAnoMes(meses);

  for (const anoMes of anosMes) {
    const { ini, fim } = rangeDoMes(anoMes);

    const [vendas, producao] = await Promise.all([
      lerSaidasVendas(Protheus, ini, fim),
      lerSaidasProducao(Protheus, ini, fim).catch(err => {
        console.warn(`[snapshot] SD3 falhou pra ${anoMes}, ignorando:`, err.message);
        return [];
      })
    ]);

    // Junta vendas + producao por (cod, armazem)
    const saidasMap = new Map();
    const acumular = (rows) => rows.forEach(r => {
      const key = `${String(r.cod_produto).trim()}|${String(r.armazem).trim()}`;
      const cur = saidasMap.get(key) || { qtd: 0, valor: 0 };
      cur.qtd += Number(r.qtd_saidas || 0);
      cur.valor += Number(r.valor_saidas || 0);
      saidasMap.set(key, cur);
    });
    acumular(vendas);
    acumular(producao);

    // Upsert mes a mes
    let upserts = 0;
    for (const r of saldo) {
      const cod = String(r.cod_produto).trim();
      const arm = String(r.armazem).trim();
      const key = `${cod}|${arm}`;
      const sa = saidasMap.get(key) || { qtd: 0, valor: 0 };

      try {
        await Pg.connectAndQuery(`
          INSERT INTO tab_estoque_snapshot_mensal (
            ano_mes, cod_produto, armazem, tipo_produto, descricao, grupo,
            qtd_estoque, custo_medio, valor_estoque,
            qtd_saidas_mes, valor_saidas_mes
          ) VALUES (
            @anoMes, @cod, @arm, @tipo, @desc, @grupo,
            @qtd, @cm, @valor,
            @qtds, @vsaidas
          )
          ON CONFLICT (ano_mes, cod_produto, armazem)
          DO UPDATE SET
            tipo_produto = EXCLUDED.tipo_produto,
            descricao    = EXCLUDED.descricao,
            grupo        = EXCLUDED.grupo,
            qtd_estoque  = EXCLUDED.qtd_estoque,
            custo_medio  = EXCLUDED.custo_medio,
            valor_estoque= EXCLUDED.valor_estoque,
            qtd_saidas_mes  = EXCLUDED.qtd_saidas_mes,
            valor_saidas_mes= EXCLUDED.valor_saidas_mes,
            snapshot_em  = NOW()`,
          {
            anoMes, cod, arm,
            tipo: String(r.tipo_produto || '').trim(),
            desc: String(r.descricao || '').trim().slice(0, 120),
            grupo: String(r.grupo || '').trim().slice(0, 10),
            qtd: Number(r.qtd_estoque || 0),
            cm: Number(r.custo_medio || 0),
            valor: Number(r.valor_estoque || 0),
            qtds: sa.qtd,
            vsaidas: sa.valor
          }
        );
        upserts++;
      } catch (e) {
        console.error(`[snapshot] erro upsert ${cod}/${arm}/${anoMes}:`, e.message);
      }
    }
    stats.meses_processados.push({ anoMes, upserts, saidas_distintas: saidasMap.size });
    console.log(`[snapshot] ${anoMes}: ${upserts} upserts, ${saidasMap.size} produtos com saida`);
  }

  stats.terminado_em = new Date().toISOString();
  stats.duracao_ms = Date.now() - inicio;
  console.log(`[snapshot] concluido em ${stats.duracao_ms}ms`);
  return stats;
}

module.exports = { atualizar };
