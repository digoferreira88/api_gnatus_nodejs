// GET /credito/analise/:cod/:loja
// Análise de Crédito 360° (Fase 0 — interno): score, indicadores, status pelo
// motor de regras, sugestão de limite e parecer com IA. Permissão 15100.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);
const Score = require('../../services/creditoScore');
const Regras = require('../../services/creditoRegras');
const Parecer = require('../../services/creditoParecer');
const Auditoria = require('../../services/auditoria');

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

// Sugestão de limite (heurística Fase 0, por faixa de score — a IA refina depois)
function sugerirLimite(scoreFinal, limiteAtual, semHistorico) {
  if (semHistorico) return { valor: limiteAtual, nota: 'Sem histórico interno — manter até consulta externa.' };
  const f = scoreFinal >= 750 ? 1.2 : scoreFinal >= 600 ? 1.0 : scoreFinal >= 400 ? 0.7 : 0.3;
  return { valor: round1(limiteAtual * f),
    nota: f > 1 ? 'Score saudável — há espaço para aumento.' : f === 1 ? 'Manter o limite atual.' : 'Score de risco — reduzir exposição.' };
}

module.exports = (app) => ({
  verb: 'get',
  route: '/analise/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const cod = String(req.params.cod || '').trim();
    const loja = String(req.params.loja || '').trim();
    const contexto = String(req.query.contexto || '').trim().toUpperCase() || null;
    if (!cod || !loja) return res.status(400).json({ message: 'Código e loja do cliente são obrigatórios.' });

    try {
      const base = await Score.calcular({ Pg, Protheus }, cod, loja);
      if (!base) return res.status(404).json({ message: 'Cliente não encontrado.' });

      // Fase 0: sem bureau -> score final = interno; protesto_ativo desconhecido (false).
      const scoreExterno = null;
      const scoreFinal = base.scoreInterno;
      const classificacao = Score.classificar(scoreFinal, null);

      // Motor de regras
      const ctx = {
        score_final: scoreFinal, score_interno: base.scoreInterno,
        media_atraso_dias: base.indicadores.mediaAtrasoPond,
        inadimplencia_pct: base.indicadores.inadimplenciaPct,
        maior_atraso_dias: base.indicadores.maiorAtraso.dias,
        protesto_ativo: false, bloqueado: base.cliente.bloqueado,
        classificacao: classificacao.label
      };
      const regra = await Regras.avaliar(Pg, ctx);
      // Cliente bloqueado no cadastro força reprovação
      const status = base.cliente.bloqueado ? 'REPROVAR' : regra.status;

      const limiteSugerido = sugerirLimite(scoreFinal, base.cliente.limite, base.indicadores.semHistorico);

      const parecer = await Parecer.gerar({
        cliente: base.cliente, indicadores: base.indicadores,
        scoreInterno: base.scoreInterno, classificacao, status
      });

      // Score evolutivo: grava 1 ponto/dia/cliente (best-effort)
      try {
        await Pg.connectAndQuery(
          `INSERT INTO tab_credito_score_hist (cliente_cod, cliente_loja, score_final, classificacao)
           SELECT @cod, @loja, @sc, @cl
            WHERE NOT EXISTS (
              SELECT 1 FROM tab_credito_score_hist
               WHERE cliente_cod=@cod AND cliente_loja=@loja AND capturado_em::date = NOW()::date)`,
          { cod, loja, sc: scoreFinal, cl: classificacao.label });
      } catch (e) { /* best-effort */ }

      const evolucao = await Pg.connectAndQuery(
        `SELECT score_final, classificacao, capturado_em
           FROM tab_credito_score_hist WHERE cliente_cod=@cod AND cliente_loja=@loja
          ORDER BY capturado_em DESC LIMIT 24`, { cod, loja }).catch(() => []);

      Auditoria.registrar(app, {
        modulo: 'Crédito', submodulo: 'Análise', acao: 'CONSULTAR', severidade: 'INFO', req,
        entidade: 'cliente', entidadeId: `${cod}/${loja}`,
        descricao: `Análise de crédito de ${base.cliente.nome} — score ${scoreFinal} (${classificacao.label}) · ${status}`,
        meta: { scoreFinal, status, contexto }
      });

      return res.json({
        cliente: base.cliente,
        contexto,
        score: { interno: base.scoreInterno, externo: scoreExterno, final: scoreFinal, classificacao },
        componentes: base.componentes,
        indicadores: base.indicadores,
        decisao: { status, regra: regra.regra, mensagem: regra.mensagem, forcadoBloqueio: base.cliente.bloqueado },
        limite: { atual: base.cliente.limite, sugerido: limiteSugerido.valor, nota: limiteSugerido.nota },
        parecer: parecer.texto, parecerFonte: parecer.fonte,
        evolucao: (evolucao || []).reverse(),
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro credito/analise:', err);
      return res.status(500).json({ message: 'Erro ao gerar análise de crédito: ' + err.message });
    }
  }
});
