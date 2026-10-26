// GET /financeiro/liberacao-produtividade?inicio=YYYYMMDD&fim=YYYYMMDD
//
// Produtividade da equipe do Financeiro: quem liberou cada pedido, quando ele
// entrou na fila e quanto tempo esperou. Base para medir a eficiência de cada
// colaborador.
//
// Fonte: SZ5010 "Log de Liberações" (tabela customizada do Protheus, 1 linha por
// item do pedido), que grava data/hora/usuário de cada etapa. Duas etapas são do
// Financeiro:
//   - FIN   = Liberação Financeira (estágio 20). Entra na fila quando o Comercial
//             libera (última liberação; a primeira, se só houve uma).
//   - RISCO = Liberação de Risco (estágio 40, "Formulação Financeira"), depois do
//             Planejamento. Entra na fila quando o Planejamento libera.
// A SZ5 guarda só a ÚLTIMA liberação de cada etapa (+ a contagem): se o pedido foi
// liberado de novo, o evento anterior se perde e conta como "reliberação".
//
// Tempo útil = minutos dentro de seg–sex 08:00–18:00 (sem feriados). O tempo na
// fila inclui espera por pagamento do cliente, por isso a tela compara pela
// mediana. A agregação por colaborador é feita no front (filtros instantâneos).
//
// Permissão 8008 (produtividade da equipe — dado de desempenho individual).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8008]);

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

const EXPEDIENTE = { inicio: 8, fim: 18 };   // horas, seg–sex

// 'YYYYMMDDHH:MM:SS' -> Date em "relógio de parede" (UTC só como suporte, sem fuso)
function parseZ5(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trim(s).replace(/\s+/g, ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  return isNaN(d.getTime()) ? null : d;
}
const fmt = (d) => d ? d.toISOString().slice(0, 16).replace('T', ' ') : '';   // 'YYYY-MM-DD HH:MM'

function minutosUteis(a, b) {
  if (!a || !b || b <= a) return 0;
  let total = 0;
  let dia = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const fim = b.getTime();
  while (dia < fim) {
    const dow = new Date(dia).getUTCDay();
    if (dow >= 1 && dow <= 5) {
      const s = Math.max(a.getTime(), dia + EXPEDIENTE.inicio * 3600e3);
      const e = Math.min(fim, dia + EXPEDIENTE.fim * 3600e3);
      if (e > s) total += (e - s) / 60000;
    }
    dia += 864e5;
  }
  return Math.round(total);
}

module.exports = (app) => ({
  verb: 'get',
  route: '/liberacao-produtividade',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const hoje = new Date();
    const inicio = /^\d{8}$/.test(trim(req.query.inicio)) ? trim(req.query.inicio) : ymd(new Date(hoje.getTime() - 30 * 864e5));
    const fim = /^\d{8}$/.test(trim(req.query.fim)) ? trim(req.query.fim) : ymd(hoje);

    // 1 linha por pedido. MAX sobre 'YYYYMMDD'+'HH:MM:SS' = a mais recente; campo
    // vazio vira NULL e não concorre.
    const sql = `
      SELECT RTRIM(z.ped) AS pedido, z.tco, z.tfi, z.ufi, z.qfi, z.tpl, z.tri, z.uri, z.qri,
             RTRIM(sc5.C5_ZTIPO) AS tipoCod, RTRIM(x5.X5_DESCRI) AS tipoNome,
             RTRIM(sc5.C5_CLIENTE) AS clienteCod, RTRIM(sa1.A1_NOME) AS clienteNome,
             CAST(ISNULL(tp6.total, 0) AS NUMERIC(14,2)) AS totalPedido
        FROM (
          SELECT Z5_FILIAL AS fil, Z5_PEDIDO AS ped,
                 MAX(CASE WHEN RTRIM(Z5_DTULIBE) <> '' THEN Z5_DTULIBE + Z5_HRULIBE
                          WHEN RTRIM(Z5_DT1LIBE) <> '' THEN Z5_DT1LIBE + Z5_HR1LIBE END) AS tco,
                 MAX(CASE WHEN RTRIM(Z5_DTLIBFI) <> '' THEN Z5_DTLIBFI + Z5_HRLIBFI END) AS tfi,
                 MAX(RTRIM(Z5_USUFINA)) AS ufi, MAX(Z5_QTLIBFI) AS qfi,
                 MAX(CASE WHEN RTRIM(Z5_DTLIBPL) <> '' THEN Z5_DTLIBPL + Z5_HRLIBPL END) AS tpl,
                 MAX(CASE WHEN RTRIM(Z5_DTLIBRI) <> '' THEN Z5_DTLIBRI + Z5_HRLIBRI END) AS tri,
                 MAX(RTRIM(Z5_USURISC)) AS uri, MAX(Z5_QTLIBRI) AS qri
            FROM SZ5010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*' AND Z5_FILIAL = '01'
             AND (Z5_DTLIBFI BETWEEN @inicio AND @fim OR Z5_DTLIBRI BETWEEN @inicio AND @fim)
           GROUP BY Z5_FILIAL, Z5_PEDIDO
        ) z
        LEFT JOIN SC5010 sc5 WITH (NOLOCK)
          ON sc5.C5_FILIAL = z.fil AND sc5.C5_NUM = z.ped AND sc5.D_E_L_E_T_ <> '*'
        LEFT JOIN SA1010 sa1 WITH (NOLOCK)
          ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
        LEFT JOIN SX5010 x5 WITH (NOLOCK)
          ON RTRIM(x5.X5_TABELA) = 'Z1' AND RTRIM(x5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_ <> '*'
        LEFT JOIN total_pedido_sc6 tp6 WITH (NOLOCK) ON tp6.c6_num = z.ped`;

    try {
      const rows = await Protheus.connectAndQuery(sql, { inicio, fim });
      const dia = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

      const eventos = [];
      const evento = (r, etapa, usuario, entrada, saida, qtd) => {
        // entrada depois da saída = o pedido foi reliberado antes e a SZ5 só guardou
        // a última entrada: sem tempo confiável.
        const ok = entrada && entrada <= saida;
        eventos.push({
          pedido: trim(r.pedido), etapa, usuario: usuario || '(sem usuário)',
          dia: dia(saida), saida: fmt(saida), entrada: ok ? fmt(entrada) : '',
          minutosUteis: ok ? minutosUteis(entrada, saida) : null,
          minutosCorridos: ok ? Math.round((saida - entrada) / 60000) : null,
          reliberacoes: Math.max(0, N(qtd) - 1),
          tipoCod: trim(r.tipoCod), tipoNome: trim(r.tipoNome) || trim(r.tipoCod) || '(sem tipo)',
          clienteCod: trim(r.clienteCod), clienteNome: trim(r.clienteNome),
          totalPedido: N(r.totalPedido)
        });
      };

      rows.forEach(r => {
        const tco = parseZ5(r.tco), tfi = parseZ5(r.tfi), tpl = parseZ5(r.tpl), tri = parseZ5(r.tri);
        if (tfi && dia(tfi) >= inicio && dia(tfi) <= fim) evento(r, 'FIN', trim(r.ufi), tco, tfi, r.qfi);
        // Risco entra na fila quando o Planejamento libera; sem Planejamento, conta
        // a partir da liberação financeira.
        if (tri && dia(tri) >= inicio && dia(tri) <= fim) {
          const ent = tpl && tpl <= tri ? tpl : (tfi && tfi <= tri ? tfi : null);
          evento(r, 'RISCO', trim(r.uri), ent, tri, r.qri);
        }
      });

      eventos.sort((a, b) => (a.saida < b.saida ? 1 : a.saida > b.saida ? -1 : 0));

      return res.json({
        periodo: { inicio, fim },
        expediente: `seg–sex ${String(EXPEDIENTE.inicio).padStart(2, '0')}h–${EXPEDIENTE.fim}h`,
        eventos,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro financeiro/liberacao-produtividade:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
