// services/creditoScore.js — Score de crédito INTERNO (0-1000) + indicadores
// financeiros, a partir SOMENTE dos dados do Protheus (SE1/SA1). Fase 0.
//
// Reaproveita a mesma matéria-prima da Cobrança (aging, atraso na baixa via
// E1_BAIXA, inadimplência = vencido/aberto). Cada componente devolve nota
// 0-1000 + peso + contribuição -> score EXPLICÁVEL (não caixa-preta).
//
// calcular({ Pg, Protheus }, cod, loja) -> { cliente, indicadores, componentes, scoreInterno, classificacao }

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

const PESOS_DEFAULT = { pontualidade: 0.28, inadimplencia: 0.20, mediaAtraso: 0.15, piorAtraso: 0.10, tendencia: 0.07, relacionamento: 0.10, utilizacao: 0.10 };
const FAIXAS_DEFAULT = [
  { min: 900, label: 'Excelente', cor: '#1a7f3a' },
  { min: 750, label: 'Baixo risco', cor: '#1e7d4f' },
  { min: 600, label: 'Médio risco', cor: '#f5a500' },
  { min: 400, label: 'Alto risco', cor: '#e55a1a' },
  { min: 0, label: 'Crítico', cor: '#c9302c' }
];

const classificar = (score, faixas) =>
  (faixas || FAIXAS_DEFAULT).find(f => score >= f.min) || (faixas || FAIXAS_DEFAULT)[faixas ? faixas.length - 1 : FAIXAS_DEFAULT.length - 1];

// YYYYMMDD de N meses atrás
const desdeMeses = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const ymdParaData = (s) => { s = trim(s); return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : ''; };

async function carregarConfig(Pg) {
  let pesos = { ...PESOS_DEFAULT }, faixas = FAIXAS_DEFAULT;
  try {
    const r = await Pg.connectAndQuery(`SELECT chave, valor FROM tab_credito_config WHERE chave IN ('pesos','classificacao')`, {});
    r.forEach(row => {
      if (row.chave === 'pesos' && row.valor) pesos = { ...PESOS_DEFAULT, ...row.valor };
      if (row.chave === 'classificacao' && Array.isArray(row.valor) && row.valor.length) faixas = row.valor;
    });
  } catch (e) { /* usa defaults */ }
  return { pesos, faixas };
}

async function calcular({ Pg, Protheus }, cod, loja) {
  const { pesos, faixas } = await carregarConfig(Pg);

  // Cadastro
  const cad = await Protheus.connectAndQuery(
    `SELECT TOP 1 RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome, RTRIM(A1_CGC) cnpj,
            RTRIM(A1_EST) uf, A1_LC limite, RTRIM(A1_RISCO) risco, RTRIM(A1_MSBLQL) bloqueado
       FROM SA1010 WITH (NOLOCK)
      WHERE A1_COD = @cod AND A1_LOJA = @loja AND D_E_L_E_T_ <> '*'`, { cod, loja });
  if (!cad.length) return null;
  const c = cad[0];
  const limite = N(c.limite);

  // Histórico de títulos (36 meses por emissão) — pagos (E1_BAIXA) + em aberto
  const its = await Protheus.connectAndQuery(
    `SELECT E1_EMISSAO emissao, E1_VENCREA vencrea, RTRIM(E1_BAIXA) baixa,
            E1_VALOR valor, E1_SALDO saldo,
            CASE WHEN RTRIM(E1_BAIXA) <> '' AND ISDATE(E1_BAIXA) = 1 AND ISDATE(E1_VENCREA) = 1
                 THEN DATEDIFF(day, CONVERT(date, E1_VENCREA, 112), CONVERT(date, E1_BAIXA, 112)) END atraso_baixa,
            CASE WHEN E1_SALDO > 0 AND ISDATE(E1_VENCREA) = 1 AND CONVERT(date, E1_VENCREA, 112) <= CONVERT(date, GETDATE())
                 THEN DATEDIFF(day, CONVERT(date, E1_VENCREA, 112), CONVERT(date, GETDATE())) END atraso_aberto,
            CASE WHEN ISDATE(E1_EMISSAO) = 1 AND ISDATE(E1_VENCREA) = 1
                 THEN DATEDIFF(day, CONVERT(date, E1_EMISSAO, 112), CONVERT(date, E1_VENCREA, 112)) END prazo_contratado,
            CASE WHEN RTRIM(E1_BAIXA) <> '' AND ISDATE(E1_BAIXA) = 1 AND ISDATE(E1_EMISSAO) = 1
                 THEN DATEDIFF(day, CONVERT(date, E1_EMISSAO, 112), CONVERT(date, E1_BAIXA, 112)) END prazo_efetivo
       FROM SE1010 WITH (NOLOCK)
      WHERE D_E_L_E_T_ <> '*' AND E1_FILIAL = '01' AND E1_CLIENTE = @cod AND E1_LOJA = @loja
        AND RTRIM(E1_TIPO) NOT IN ('RA','NCC') AND E1_EMISSAO >= @desde`,
    { cod, loja, desde: desdeMeses(36) });

  // ===== Acumuladores =====
  let pagos = 0, pagosNoPrazo = 0, somaAtrasoPagos = 0, somaAtrasoPond = 0, valorPagosAtraso = 0;
  let emAberto = 0, vencidoAberto = 0, qtVencidosAbertos = 0;
  let somaPrazoContr = 0, nPrazoContr = 0, somaPrazoEfet = 0, nPrazoEfet = 0;
  let maior = { dias: 0, valor: 0, data: '' };
  let minEmissao = '99999999';
  // janela 12/24m por vencimento (índice de inadimplência) + tendência 6m
  const venc12 = desdeMeses(12), venc24 = desdeMeses(24), venc6 = desdeMeses(6), venc12b = desdeMeses(12);
  let in12base = 0, in12mau = 0, in24base = 0, in24mau = 0;
  let atrasoRecente = [], atrasoAnterior = [];   // tendência (média de atraso na baixa por janela)

  its.forEach(r => {
    const valor = N(r.valor), saldo = N(r.saldo);
    const emissao = trim(r.emissao), vencrea = trim(r.vencrea);
    if (emissao && emissao < minEmissao) minEmissao = emissao;

    const pago = r.atraso_baixa !== null && r.atraso_baixa !== undefined;
    if (pago) {
      const at = Math.max(0, N(r.atraso_baixa));
      pagos++; if (at <= 0) pagosNoPrazo++;
      somaAtrasoPagos += at; somaAtrasoPond += at * valor; valorPagosAtraso += valor;
      if (r.prazo_efetivo != null) { somaPrazoEfet += N(r.prazo_efetivo); nPrazoEfet++; }
      if (at > maior.dias) maior = { dias: at, valor, data: ymdParaData(r.baixa) };
      // tendência: atraso na baixa por janela de vencimento
      if (vencrea >= venc6) atrasoRecente.push(at);
      else if (vencrea >= venc12b) atrasoAnterior.push(at);
    }
    if (r.prazo_contratado != null) { somaPrazoContr += N(r.prazo_contratado); nPrazoContr++; }
    if (saldo > 0) {
      emAberto += saldo;
      const ab = r.atraso_aberto;
      if (ab != null) { vencidoAberto += saldo; qtVencidosAbertos++; if (N(ab) > maior.dias) maior = { dias: N(ab), valor: saldo, data: '' }; }
    }
    // índice de inadimplência por janela (títulos com vencimento na janela; "mau" = pago em atraso ou em aberto vencido)
    const mau = (pago && N(r.atraso_baixa) > 0) || (saldo > 0 && r.atraso_aberto != null);
    if (vencrea >= venc12) { in12base += valor; if (mau) in12mau += valor; }
    if (vencrea >= venc24) { in24base += valor; if (mau) in24mau += valor; }
  });

  const qtdTitulos = its.length;
  const semHistorico = pagos === 0 && emAberto === 0;
  const semLimite = limite <= 0;

  const pontualidadePct = pagos > 0 ? (pagosNoPrazo / pagos) * 100 : null;
  const mediaAtrasoDias = pagos > 0 ? somaAtrasoPagos / pagos : 0;
  const mediaAtrasoPond = valorPagosAtraso > 0 ? somaAtrasoPond / valorPagosAtraso : 0;
  const inadimplenciaPct = emAberto > 0 ? (vencidoAberto / emAberto) * 100 : 0;
  const inad12Pct = in12base > 0 ? (in12mau / in12base) * 100 : 0;
  const inad24Pct = in24base > 0 ? (in24mau / in24base) * 100 : 0;
  const utilizacaoPct = limite > 0 ? (emAberto / limite) * 100 : null;
  const prazoContratadoMedio = nPrazoContr > 0 ? somaPrazoContr / nPrazoContr : 0;
  const prazoEfetivoMedio = nPrazoEfet > 0 ? somaPrazoEfet / nPrazoEfet : 0;
  const mesesBase = minEmissao !== '99999999'
    ? Math.max(0, Math.round((Date.now() - new Date(Number(minEmissao.slice(0,4)), Number(minEmissao.slice(4,6)) - 1, Number(minEmissao.slice(6,8))).getTime()) / (1000 * 60 * 60 * 24 * 30)))
    : 0;
  const freqMensal = mesesBase > 0 ? qtdTitulos / mesesBase : 0;
  const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const atRec = avg(atrasoRecente), atAnt = avg(atrasoAnterior);
  const deltaAtrasoDias = (atRec != null && atAnt != null) ? atRec - atAnt : 0;   // >0 = piora
  const piora = deltaAtrasoDias > 2;

  // ===== Componentes (0-1000) =====
  const nota = {
    pontualidade: pontualidadePct != null ? clamp(pontualidadePct * 10, 0, 1000) : 500,
    inadimplencia: clamp(1000 * (1 - clamp(inadimplenciaPct / 100, 0, 1)), 0, 1000),
    mediaAtraso: clamp(1000 - mediaAtrasoPond * (1000 / 60), 0, 1000),     // 0d=1000, 60d=0
    piorAtraso: clamp(1000 - maior.dias * (1000 / 90), 0, 1000),           // 0d=1000, 90d=0
    tendencia: clamp(700 - deltaAtrasoDias * 12, 0, 1000),                 // melhora sobe, piora desce
    relacionamento: clamp(300 + Math.min(mesesBase, 36) / 36 * 600 + Math.min(freqMensal, 4) / 4 * 100, 0, 1000),
    utilizacao: utilizacaoPct == null ? 500 : (utilizacaoPct <= 50 ? 1000 : clamp(1000 - (utilizacaoPct - 50) * 20, 0, 1000)) // 50%=1000,100%=0
  };

  const LABELS = {
    pontualidade: 'Pontualidade de pagamento', inadimplencia: 'Inadimplência atual',
    mediaAtraso: 'Média de atraso (ponderada)', piorAtraso: 'Maior atraso registrado',
    tendencia: 'Tendência (6 meses)', relacionamento: 'Relacionamento / recorrência', utilizacao: 'Utilização de limite'
  };
  let scoreInterno = 0;
  const componentes = Object.keys(pesos).filter(k => nota[k] != null).map(k => {
    const contrib = nota[k] * pesos[k];
    scoreInterno += contrib;
    return { chave: k, label: LABELS[k] || k, nota: round1(nota[k]), peso: pesos[k], contribuicao: round1(contrib) };
  });
  scoreInterno = round1(semHistorico ? 500 : scoreInterno);

  return {
    cliente: { cod: trim(c.cod), loja: trim(c.loja), nome: trim(c.nome), cnpj: trim(c.cnpj), uf: trim(c.uf), limite, risco: trim(c.risco), bloqueado: trim(c.bloqueado) === '1' },
    indicadores: {
      qtdTitulos, pagos, qtVencidosAbertos, semHistorico, semLimite,
      pontualidadePct: pontualidadePct != null ? round1(pontualidadePct) : null,
      mediaAtrasoDias: round1(mediaAtrasoDias), mediaAtrasoPond: round1(mediaAtrasoPond),
      maiorAtraso: { dias: maior.dias, valor: round1(maior.valor), data: maior.data },
      inadimplenciaPct: round1(inadimplenciaPct), inad12Pct: round1(inad12Pct), inad24Pct: round1(inad24Pct),
      emAberto: round1(emAberto), vencidoAberto: round1(vencidoAberto),
      utilizacaoPct: utilizacaoPct != null ? round1(utilizacaoPct) : null,
      prazoContratadoMedio: round1(prazoContratadoMedio), prazoEfetivoMedio: round1(prazoEfetivoMedio),
      mesesBase, freqMensal: round1(freqMensal),
      tendencia: { deltaAtrasoDias: round1(deltaAtrasoDias), piora }
    },
    componentes,
    scoreInterno,
    classificacao: classificar(scoreInterno, faixas)
  };
}

module.exports = { calcular, classificar, PESOS_DEFAULT, FAIXAS_DEFAULT };
