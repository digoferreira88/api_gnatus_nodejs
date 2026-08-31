// GET /sac/nps/dashboard?inicio=&fim=
// Indicadores + dados dos gráficos da Pesquisa de Pós-venda. Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const N = (v) => Number(v || 0);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/nps/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    // ---------------------------------------------------------------------
    // DOIS EIXOS DE DATA, de propósito:
    //
    //   RESPOSTA (c.respondido_em) — CSAT, NPS, distribuição, causas,
    //     segmentos e nuvem. É o que o cliente respondeu naquele mês, não
    //     importa quando o convite saiu. É o eixo do filtro da tela.
    //
    //   SAFRA (c.criado_em) — enviados, pendentes e taxa de resposta.
    //     Taxa de resposta só significa alguma coisa por safra: do que saiu
    //     no mês, quanto voltou. Se contasse resposta por respondido_em e
    //     envio por criado_em no mesmo denominador, um mês com muita resposta
    //     atrasada passaria de 100%.
    // ---------------------------------------------------------------------
    const p = {};
    let ini = trim(req.query.inicio);
    let fim = trim(req.query.fim);

    // ?mes=YYYY-MM é o atalho usado pela tela; inicio/fim continuam valendo
    // para quem quiser um intervalo livre.
    const mes = trim(req.query.mes);
    if (/^\d{4}-\d{2}$/.test(mes)) {
      const ano = Number(mes.slice(0, 4)), m = Number(mes.slice(5, 7));
      const ultimo = new Date(ano, m, 0).getDate();   // dia 0 do mês seguinte
      ini = `${mes}-01`;
      fim = `${mes}-${String(ultimo).padStart(2, '0')}`;
    }

    const condResp = [], condEnv = [];
    if (ini) {
      condResp.push('c.respondido_em >= @inicio');
      condEnv.push('c.criado_em >= @inicio');
      p.inicio = ini;
    }
    if (fim) {
      condResp.push('c.respondido_em < (@fim::date + 1)');
      condEnv.push('c.criado_em < (@fim::date + 1)');
      p.fim = fim;
    }

    // `conds`/`where` seguem com os nomes antigos, mas agora significam a
    // janela da RESPOSTA — é o eixo de tudo que descreve o que o cliente disse.
    const conds = condResp;
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const whereEnv = condEnv.length ? 'WHERE ' + condEnv.join(' AND ') : '';

    try {
      // Respostas do período — eixo respondido_em.
      const tot = await Pg.connectAndQuery(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'RESPONDIDO') respondidos,
          COUNT(*) FILTER (WHERE classificacao = 'PROMOTOR') promotores,
          COUNT(*) FILTER (WHERE classificacao = 'NEUTRO')   neutros,
          COUNT(*) FILTER (WHERE classificacao = 'DETRATOR') detratores,
          AVG(nota_nps) FILTER (WHERE nota_nps IS NOT NULL)  media
        FROM tab_nps_convite c
        ${where ? where + ' AND' : 'WHERE'} c.respondido_em IS NOT NULL`, p);
      const t = tot[0] || {};
      const respondidos = N(t.respondidos);

      // Safra do período — eixo criado_em: do que saiu, quanto voltou.
      const saf = await Pg.connectAndQuery(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('ENVIADO','RESPONDIDO')) enviados,
          COUNT(*) FILTER (WHERE status = 'RESPONDIDO') respondidos
        FROM tab_nps_convite c ${whereEnv}`, p);
      const s = saf[0] || {};
      const safEnviados = N(s.enviados), safRespondidos = N(s.respondidos);

      // Meses que têm resposta — alimenta o seletor da tela. Sempre completo,
      // independente do filtro, senão o seletor perderia as outras opções.
      const mesesRows = await Pg.connectAndQuery(`
        SELECT to_char(date_trunc('month', respondido_em), 'YYYY-MM') mes,
               COUNT(*) qtd
          FROM tab_nps_convite
         WHERE respondido_em IS NOT NULL
         GROUP BY 1 ORDER BY 1 DESC`, {});
      const mesesDisponiveis = mesesRows.map(r => ({ mes: trim(r.mes), qtd: N(r.qtd) }));
      const promotores = N(t.promotores), detratores = N(t.detratores), neutros = N(t.neutros);
      const npsScore = respondidos > 0 ? Math.round(((promotores - detratores) / respondidos) * 100) : null;

      // Distribuição das respostas da pergunta classificadora. CSAT (opção): por
      // rótulo, na ordem das opções, colorido pela classificação (class_map).
      // NPS/escala: por nota. Fallback: 0-10 da nota_nps.
      const pNpsRows = await Pg.connectAndQuery(
        `SELECT id, tipo, opcoes, class_map FROM tab_nps_pergunta WHERE e_nps AND ativa ORDER BY ordem LIMIT 1`, {});
      const pNps = pNpsRows[0];
      let distribuicao = [];
      if (pNps && trim(pNps.tipo) === 'opcao') {
        const rows = await Pg.connectAndQuery(`
          SELECT r.opcao rotulo, COUNT(*) qtd
            FROM tab_nps_resposta r JOIN tab_nps_convite c ON c.id = r.convite_id
           WHERE r.pergunta_id = @pid AND COALESCE(r.opcao,'') <> '' ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
           GROUP BY r.opcao`, { ...p, pid: pNps.id });
        const cnt = new Map(rows.map(r => [trim(r.rotulo), N(r.qtd)]));
        const cmap = pNps.class_map || {};
        const opts = Array.isArray(pNps.opcoes) ? pNps.opcoes : [...cnt.keys()];
        distribuicao = opts.map(o => ({ rotulo: o, qtd: cnt.get(o) || 0, classificacao: trim(cmap[o]).toUpperCase() }));
      } else {
        const dist = await Pg.connectAndQuery(`
          SELECT nota_nps nota, COUNT(*) qtd FROM tab_nps_convite c
          ${where ? where + ' AND' : 'WHERE'} nota_nps IS NOT NULL
          GROUP BY nota_nps ORDER BY nota_nps`, p);
        const distMap = new Map(dist.map(d => [N(d.nota), N(d.qtd)]));
        distribuicao = Array.from({ length: 11 }, (_, i) => ({ rotulo: String(i), nota: i, qtd: distMap.get(i) || 0 }));
      }

      // Detalhe da distribuição DENTRO de cada categoria: quantas pessoas deram
      // cada nota/opção. Alimenta a legenda granular do donut ("4 deram nota 8").
      // Agrupa pela classificacao gravada no convite, então os subtotais sempre
      // fecham com Promotores/Neutros/Detratores do KPI.
      const detalhe = { PROMOTOR: [], NEUTRO: [], DETRATOR: [] };
      if (pNps && trim(pNps.tipo) === 'opcao') {
        const rows = await Pg.connectAndQuery(`
          SELECT COALESCE(c.classificacao,'') cls, r.opcao rotulo, COUNT(*) qtd
            FROM tab_nps_resposta r JOIN tab_nps_convite c ON c.id = r.convite_id
           WHERE r.pergunta_id = @pid AND COALESCE(r.opcao,'') <> '' ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
           GROUP BY 1, 2`, { ...p, pid: pNps.id });
        const opts = Array.isArray(pNps.opcoes) ? pNps.opcoes : [];
        const ord = (r) => { const i = opts.indexOf(trim(r.rotulo)); return i < 0 ? 999 : i; };   // ordem do formulário
        rows.sort((a, b) => ord(a) - ord(b));
        rows.forEach((r) => {
          const c = trim(r.cls).toUpperCase();
          if (detalhe[c]) detalhe[c].push({ rotulo: trim(r.rotulo), qtd: N(r.qtd) });
        });
      } else {
        const rows = await Pg.connectAndQuery(`
          SELECT COALESCE(classificacao,'') cls, nota_nps nota, COUNT(*) qtd
            FROM tab_nps_convite c
          ${where ? where + ' AND' : 'WHERE'} nota_nps IS NOT NULL
           GROUP BY 1, 2 ORDER BY nota_nps DESC`, p);
        rows.forEach((r) => {
          const c = trim(r.cls).toUpperCase();
          if (detalhe[c]) detalhe[c].push({ rotulo: `Nota ${N(r.nota)}`, nota: N(r.nota), qtd: N(r.qtd) });
        });
      }

      // Pareto de causas (regra CX: classificar a causa do detrator + Pareto mensal).
      const causaRows = await Pg.connectAndQuery(`
        SELECT a.causa rotulo, COUNT(*) qtd
          FROM tab_nps_acao a JOIN tab_nps_convite c ON c.id = a.convite_id
         WHERE COALESCE(a.causa,'') <> '' ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY a.causa ORDER BY qtd DESC LIMIT 20`, p);
      const totalCausas = causaRows.reduce((s, r) => s + N(r.qtd), 0);
      let acum = 0;
      const pareto = causaRows.map(r => {
        acum += N(r.qtd);
        return {
          causa: trim(r.rotulo), qtd: N(r.qtd),
          pct: totalCausas > 0 ? +(N(r.qtd) / totalCausas * 100).toFixed(1) : 0,
          acumuladoPct: totalCausas > 0 ? +(acum / totalCausas * 100).toFixed(1) : 0
        };
      });

      // evolução mensal (últimos 12 meses respondidos)
      const evo = await Pg.connectAndQuery(`
        -- A evolução IGNORA o filtro de mês de propósito: ela existe para
        -- mostrar a tendência, e filtrada por um mês viraria um ponto só. A
        -- tela destaca nela o mês selecionado.
        SELECT to_char(date_trunc('month', respondido_em), 'YYYY-MM') mes,
               COUNT(*) FILTER (WHERE classificacao='PROMOTOR') promotores,
               COUNT(*) FILTER (WHERE classificacao='NEUTRO')   neutros,
               COUNT(*) FILTER (WHERE classificacao='DETRATOR') detratores,
               COUNT(*) total
          FROM tab_nps_convite c
         WHERE respondido_em IS NOT NULL
         GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, {});
      const evolucao = evo.map(e => {
        const total = N(e.total);
        const nps = total > 0 ? Math.round(((N(e.promotores) - N(e.detratores)) / total) * 100) : 0;
        return { mes: e.mes, promotores: N(e.promotores), neutros: N(e.neutros), detratores: N(e.detratores), total, nps };
      }).reverse();

      // Segmentação: NPS por BU / vendedor / transportadora / linha de produto.
      // Só considera respondidos com classificação. Ordena por volume.
      const segmentar = async (colCod, colNome) => {
        const rows = await Pg.connectAndQuery(`
          SELECT COALESCE(NULLIF(${colNome}, ''), NULLIF(${colCod}, ''), '(não informado)') rotulo,
                 COUNT(*) total,
                 COUNT(*) FILTER (WHERE classificacao='PROMOTOR') prom,
                 COUNT(*) FILTER (WHERE classificacao='DETRATOR') detr
            FROM tab_nps_convite c
           WHERE classificacao IS NOT NULL ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
           GROUP BY 1 ORDER BY total DESC LIMIT 15`, p);
        return rows.map(r => ({
          rotulo: r.rotulo, total: N(r.total),
          nps: N(r.total) > 0 ? Math.round(((N(r.prom) - N(r.detr)) / N(r.total)) * 100) : 0,
          csat: N(r.total) > 0 ? Math.round((N(r.prom) / N(r.total)) * 100) : 0,   // % satisfeitos (top-box CSAT)
          detratores: N(r.detr)
        }));
      };
      const [porBu, porVendedor, porTransportadora, porLinha] = await Promise.all([
        segmentar('bu_cod', 'bu_nome'),
        segmentar('vendedor_cod', 'vendedor_nome'),
        segmentar('transportadora_cod', 'transportadora_nome'),
        segmentar('linha_cod', 'linha_desc')
      ]);

      // Nuvem de ELOGIOS: frequência de palavras nos textos livres dos clientes
      // SATISFEITOS (PROMOTOR). Reclamações já vêm do Pareto de causas; aqui é o
      // lado positivo. Tokeniza em JS (SQL de contagem de palavras é penoso).
      const STOP = new Set(('a o e é de do da dos das em no na nos nas um uma uns umas que com por para pra pro ao aos à às se sua seu suas seus meu minha muito muita muitos muitas mais menos foi ser sao são está esta estao estão tem ter teve tudo todo toda todos todas isso este esta esse essa isto aquele aquela como mas também tambem já ja sempre nao não sim pela pelo pelos pelas eles elas ele ela você voce vcs nossa nosso nossos nossas la lá aqui ali entao então quando onde qual quais porque pois so só ate até das dos me te lhe nos vos sem sob sobre entre eu tu ele nós vós me minha muito bem ainda cada pode fazer sendo estou vou aqui assim depois antes agora ficou fica gostei preciso usei sido').split(/\s+/));
      let elogios = [];
      try {
        const txtRows = await Pg.connectAndQuery(`
          SELECT r.texto FROM tab_nps_resposta r JOIN tab_nps_convite c ON c.id = r.convite_id
           WHERE COALESCE(r.texto,'') <> '' AND c.classificacao = 'PROMOTOR'
             ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
           ORDER BY r.id DESC LIMIT 1000`, p);
        const freq = new Map();
        for (const row of txtRows) {
          const seen = new Set();   // conta 1x por resposta (não infla com repetição na mesma frase)
          String(row.texto).toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')  // remove acento p/ agrupar
            .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
            .forEach(w => {
              if (w.length < 4 || STOP.has(w)) return;
              if (seen.has(w)) return; seen.add(w);
              freq.set(w, (freq.get(w) || 0) + 1);
            });
        }
        elogios = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
          .map(([palavra, qtd]) => ({ palavra, qtd }));
      } catch (e) { console.warn('[nps-dashboard] elogios:', e.message); }

      return res.json({
        segmentos: { porBu, porVendedor, porTransportadora, porLinha },
        // Período efetivamente aplicado, para a tela rotular os blocos sem
        // recalcular a data por conta própria.
        periodo: { mes: /^\d{4}-\d{2}$/.test(mes) ? mes : null, inicio: ini || null, fim: fim || null },
        mesesDisponiveis,
        kpis: {
          // Eixo SAFRA (criado_em) — o trio da taxa de resposta fecha entre si.
          enviados: safEnviados,
          respondidosSafra: safRespondidos,
          pendentes: Math.max(0, safEnviados - safRespondidos),
          taxaResposta: safEnviados > 0 ? +(safRespondidos / safEnviados * 100).toFixed(1) : 0,
          // Eixo RESPOSTA (respondido_em) — daqui para baixo é o que o cliente
          // respondeu no período.
          respondidos,
          promotores, neutros, detratores,
          // CSAT (top-box): % de clientes satisfeitos (PROMOTOR) sobre os respondidos.
          csat: respondidos > 0 ? Math.round((promotores / respondidos) * 100) : null,
          media: t.media != null ? +N(t.media).toFixed(1) : null,
          npsScore
        },
        distribuicao,
        elogios,
        pareto,
        classificacao: [
          { nome: 'Promotores', valor: promotores, cor: '#1e7d4f', detalhe: detalhe.PROMOTOR },
          { nome: 'Neutros', valor: neutros, cor: '#f5a500', detalhe: detalhe.NEUTRO },
          { nome: 'Detratores', valor: detratores, cor: '#c0392b', detalhe: detalhe.DETRATOR }
        ],
        evolucao,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('sac/nps-dashboard:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
