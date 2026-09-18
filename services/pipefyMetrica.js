// services/pipefyMetrica.js — quantas requisições cada rotina manda para a API do
// Pipefy. O contrato é de 10.000 chamadas/mês e o Pipefy não expõe o consumo; sem
// isto, só a fatura conta a história (setembro/2026 fechou em ~25.800).
//
// Conta em memória e grava a cada 10 min (job "pipefy-uso" do scheduler), para não
// trocar uma requisição HTTP por um INSERT. Contagem perdida num restart é aceitável:
// serve para acompanhar tendência, não para cobrança.
//
// Uso: Metrica.contar('rhp-recon') dentro do wrapper gql de cada serviço.

const pendentes = new Map();   // 'YYYY-MM-DD|rotina' -> chamadas

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

function contar(rotina, n = 1) {
  const k = `${hoje()}|${String(rotina || 'desconhecida')}`;
  pendentes.set(k, (pendentes.get(k) || 0) + n);
}

// Grava o acumulado. Nunca lança: métrica não pode derrubar rotina.
async function flush(app) {
  if (!pendentes.size) return { gravadas: 0 };
  const { Pg } = app.services ? app.services : app;
  const lote = [...pendentes.entries()];
  pendentes.clear();
  let gravadas = 0;
  for (const [k, n] of lote) {
    const [dia, rotina] = k.split('|');
    try {
      await Pg.connectAndQuery(
        `INSERT INTO tab_pipefy_uso (dia, rotina, chamadas) VALUES (@dia::date, @rotina, @n)
         ON CONFLICT (dia, rotina) DO UPDATE SET chamadas = tab_pipefy_uso.chamadas + EXCLUDED.chamadas`,
        { dia, rotina, n });
      gravadas += n;
    } catch (e) {
      // devolve para a próxima rodada em vez de perder a contagem
      pendentes.set(k, (pendentes.get(k) || 0) + n);
      console.warn('[pipefy-uso] não gravou:', e.message);
      break;
    }
  }
  return { gravadas };
}

// Consumo por rotina no mês corrente (mais o que ainda está em memória).
async function resumoDoMes(app) {
  const { Pg } = app.services ? app.services : app;
  const rows = await Pg.connectAndQuery(
    `SELECT rotina, SUM(chamadas)::int chamadas FROM tab_pipefy_uso
      WHERE dia >= date_trunc('month', CURRENT_DATE) GROUP BY rotina ORDER BY 2 DESC`, {});
  const memoria = {};
  pendentes.forEach((n, k) => { const r = k.split('|')[1]; memoria[r] = (memoria[r] || 0) + n; });
  const total = rows.reduce((s, r) => s + Number(r.chamadas), 0) + Object.values(memoria).reduce((s, n) => s + n, 0);
  return { rotinas: rows, aindaEmMemoria: memoria, total };
}

module.exports = { contar, flush, resumoDoMes };
