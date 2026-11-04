// GET /financeiro/credito-registro-produtividade?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
//
// Produtividade da equipe de crédito a partir do Registro de Análise de Crédito.
// Devolve 1 evento por ANÁLISE registrada no período (data da 1ª versão, no fuso
// de Brasília), creditada a quem a registrou, com o resultado FINAL (versão
// vigente). E 1 evento por EDIÇÃO (versões 2+) feita no período.
//
// Indicadores que o front monta:
//   - volume por analista/dia, por canal (Liberação × Manual) e origem;
//   - resultado final (aprovadas, reprovadas, pendentes);
//   - tempo de resposta = registro − recebimento da solicitação (só quando o
//     analista informou o recebimento), em minutos úteis (seg–sex 08–18h) e corridos;
//   - reanálise = o mesmo CPF/CNPJ já tinha análise nos JANELA_DUPLICIDADE_DIAS
//     anteriores (retrabalho que o cruzamento quer evitar).
//
// Permissão 8008 (produtividade da equipe — mesma da aba de liberações).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8008]);
const CR = require('../../services/creditoRegistro');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const iso = /^\d{4}-\d{2}-\d{2}$/;

// Minutos dentro do expediente (seg–sex 08–18h, sem feriados) entre dois instantes.
// Converte para o relógio de Brasília (UTC−3, sem horário de verão) e conta em UTC.
const EXPEDIENTE = { inicio: 8, fim: 18 };
const BRT = 3 * 3600e3;
function minutosUteis(ini, fim) {
  if (!ini || !fim) return null;
  const a = ini.getTime() - BRT, b = fim.getTime() - BRT;
  if (b <= a) return 0;
  let total = 0;
  const d0 = new Date(a);
  let dia = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
  while (dia < b) {
    const dow = new Date(dia).getUTCDay();
    if (dow >= 1 && dow <= 5) {
      const s = Math.max(a, dia + EXPEDIENTE.inicio * 3600e3);
      const e = Math.min(b, dia + EXPEDIENTE.fim * 3600e3);
      if (e > s) total += (e - s) / 60000;
    }
    dia += 864e5;
  }
  return Math.round(total);
}

module.exports = (app) => ({
  verb: 'get',
  route: '/credito-registro-produtividade',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const hoje = CR.hojeBrasilia();
    const inicio = iso.test(trim(req.query.inicio)) ? trim(req.query.inicio) : new Date(Date.now() - BRT - 30 * 864e5).toISOString().slice(0, 10);
    const fim = iso.test(trim(req.query.fim)) ? trim(req.query.fim) : hoje;

    try {
      // A janela de reanálise olha para TODAS as análises (inclusive antes do
      // período): a anterior do mesmo documento vem do LAG sobre o histórico todo.
      const analises = await Pg.connectAndQuery(`
        WITH base AS (
          SELECT v1.grupo_id, v1.analista_id, v1.analista_nome, v1.criado_em, v1.solicitado_em,
                 v1.canal, v1.canal_origem, v1.tipo_analise, v1.duplicidade_confirmada,
                 vg.resultado, vg.valor_total, vg.versao, vg.documento, vg.pedido,
                 vg.cliente_cod, vg.cliente_nome, vg.bu_nome
            FROM tab_credito_registro v1
            JOIN tab_credito_registro vg ON vg.grupo_id = v1.grupo_id AND vg.vigente
           WHERE v1.versao = 1
        ), com_anterior AS (
          SELECT b.*,
                 CASE WHEN b.documento IS NULL THEN NULL
                      ELSE LAG(b.criado_em) OVER (PARTITION BY b.documento ORDER BY b.criado_em, b.grupo_id) END AS anterior_em
            FROM base b
        )
        SELECT c.*, to_char(c.criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia
          FROM com_anterior c
         WHERE (c.criado_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN @inicio::date AND @fim::date
         ORDER BY c.criado_em DESC`, { inicio, fim });

      const edicoes = await Pg.connectAndQuery(`
        SELECT r.grupo_id, r.versao, r.analista_nome, r.criado_em,
               to_char(r.criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia
          FROM tab_credito_registro r
         WHERE r.versao > 1
           AND (r.criado_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN @inicio::date AND @fim::date
         ORDER BY r.criado_em DESC`, { inicio, fim });

      const janelaMs = CR.JANELA_DUPLICIDADE_DIAS * 864e5;
      return res.json({
        periodo: { inicio, fim },
        janelaDias: CR.JANELA_DUPLICIDADE_DIAS,
        expediente: 'seg–sex 08h–18h',
        analises: analises.map((r) => {
          const criado = new Date(r.criado_em);
          const solicitado = r.solicitado_em ? new Date(r.solicitado_em) : null;
          const anterior = r.anterior_em ? new Date(r.anterior_em) : null;
          const desdeAnterior = anterior ? criado.getTime() - anterior.getTime() : null;
          return {
            grupoId: r.grupo_id, analista: trim(r.analista_nome) || '(sem nome)', dia: r.dia, criadoEm: r.criado_em,
            canal: trim(r.canal), canalOrigem: trim(r.canal_origem), tipoAnalise: trim(r.tipo_analise),
            resultado: trim(r.resultado), aprovado: CR.ehAprovacao(r.resultado), versoes: N(r.versao),
            valorTotal: N(r.valor_total), documento: trim(r.documento), pedido: trim(r.pedido),
            clienteCod: trim(r.cliente_cod), clienteNome: trim(r.cliente_nome), buNome: trim(r.bu_nome),
            solicitadoEm: r.solicitado_em || null,
            minutosResposta: solicitado ? minutosUteis(solicitado, criado) : null,
            minutosRespostaCorridos: solicitado ? Math.max(0, Math.round((criado - solicitado) / 60000)) : null,
            diasDesdeAnterior: desdeAnterior != null ? Math.floor(desdeAnterior / 864e5) : null,
            reanalise: desdeAnterior != null && desdeAnterior <= janelaMs,
            duplicidadeConfirmada: !!r.duplicidade_confirmada
          };
        }),
        edicoes: edicoes.map((r) => ({
          grupoId: r.grupo_id, versao: r.versao, analista: trim(r.analista_nome) || '(sem nome)', dia: r.dia, criadoEm: r.criado_em
        }))
      });
    } catch (err) {
      console.error('financeiro/credito-registro-produtividade:', err);
      return res.status(500).json({ message: 'Erro ao carregar a produtividade: ' + err.message });
    }
  }
});
