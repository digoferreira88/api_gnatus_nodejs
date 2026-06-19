// GET /producao/dashboard-op
// Painel de Ordens de Produção (para TV): abertas x encerradas, comparativo
// mensal (13 meses) e anual (6 anos), WIP em aberto. Fonte: SC2010 (1 OP =
// 1 C2_NUM; várias sequências por OP → agrega por C2_NUM). C2_EMISSAO = abertura,
// C2_DATRF = encerramento (vazio = aberta). Perm 14001/14002/14003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14003, 14002, 14001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

// OP agregada por C2_NUM: emissão (abertura) e data de encerramento (NULL se
// alguma sequência ainda está aberta = OP em aberto).
const OPAGG = `(
  SELECT C2_NUM num, MIN(C2_EMISSAO) emissao,
         CASE WHEN MIN(CASE WHEN RTRIM(ISNULL(C2_DATRF,''))='' THEN 0 ELSE 1 END)=1
              THEN MAX(C2_DATRF) ELSE NULL END dataenc
    FROM SC2010 WITH (NOLOCK)
   WHERE C2_FILIAL='01' AND D_E_L_E_T_<>'*' AND ISNULL(C2_EMISSAO,'')<>''
   GROUP BY C2_NUM
) op`;

module.exports = (app) => ({
  verb: 'get',
  route: '/dashboard-op',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const now = new Date();
    const hoje = ymd(now);
    const ini13 = ymd(new Date(now.getFullYear(), now.getMonth() - 12, 1)); // 13 meses (atual + 12)
    const iniAno = `${now.getFullYear() - 5}0101`; // 6 anos
    const params = { ini13, iniAno, hoje };

    try {
      const [emAbertoRow, hojeAb, hojeEnc, mAb, mEnc, aAb, aEnc, wip, tempo] = await Promise.all([
        Protheus.connectAndQuery(`SELECT COUNT(*) n FROM ${OPAGG} WHERE op.dataenc IS NULL`, {}),
        Protheus.connectAndQuery(`SELECT COUNT(*) n FROM ${OPAGG} WHERE op.emissao=@hoje`, params),
        Protheus.connectAndQuery(`SELECT COUNT(*) n FROM ${OPAGG} WHERE op.dataenc=@hoje`, params),
        Protheus.connectAndQuery(`SELECT LEFT(op.emissao,6) ym, COUNT(*) n FROM ${OPAGG} WHERE op.emissao>=@ini13 GROUP BY LEFT(op.emissao,6)`, params),
        Protheus.connectAndQuery(`SELECT LEFT(op.dataenc,6) ym, COUNT(*) n FROM ${OPAGG} WHERE op.dataenc>=@ini13 GROUP BY LEFT(op.dataenc,6)`, params),
        Protheus.connectAndQuery(`SELECT LEFT(op.emissao,4) ano, COUNT(*) n FROM ${OPAGG} WHERE op.emissao>=@iniAno GROUP BY LEFT(op.emissao,4)`, params),
        Protheus.connectAndQuery(`SELECT LEFT(op.dataenc,4) ano, COUNT(*) n FROM ${OPAGG} WHERE op.dataenc>=@iniAno GROUP BY LEFT(op.dataenc,4)`, params),
        Protheus.connectAndQuery(`
          SELECT sc2.C2_NUM num, MIN(sc2.C2_EMISSAO) emissao, MAX(RTRIM(sc2.C2_PRODUTO)) produto,
                 MAX(sc2.C2_QUANT) quant, MAX(sc2.C2_QUJE) qje
            FROM SC2010 sc2 WITH (NOLOCK)
           WHERE sc2.C2_FILIAL='01' AND sc2.D_E_L_E_T_<>'*' AND ISNULL(sc2.C2_EMISSAO,'')<>''
           GROUP BY sc2.C2_NUM
          HAVING MIN(CASE WHEN RTRIM(ISNULL(sc2.C2_DATRF,''))='' THEN 0 ELSE 1 END)=0
           ORDER BY MIN(sc2.C2_EMISSAO)`, {}),
        // tempo médio de encerramento (dias) das OPs encerradas nos últimos 90 dias
        Protheus.connectAndQuery(`SELECT AVG(CAST(DATEDIFF(day, CONVERT(date, op.emissao, 112), CONVERT(date, op.dataenc, 112)) AS FLOAT)) dias
                                    FROM ${OPAGG} WHERE op.dataenc>=@ini90`, { ini90: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90)) })
      ]);

      // resolve descrições dos produtos do WIP
      const prods = [...new Set(wip.map(w => trim(w.produto)).filter(Boolean))];
      const descMap = new Map();
      if (prods.length) {
        for (let i = 0; i < prods.length; i += 500) {
          const inP = prods.slice(i, i + 500).map(p => `'${p.replace(/'/g, "''")}'`).join(',');
          const ds = await Protheus.connectAndQuery(`SELECT RTRIM(B1_COD) cod, RTRIM(B1_DESC) desc1 FROM SB1010 WITH (NOLOCK) WHERE B1_FILIAL='01' AND D_E_L_E_T_<>'*' AND RTRIM(B1_COD) IN (${inP})`, {});
          ds.forEach(d => descMap.set(trim(d.cod), trim(d.desc1)));
        }
      }

      // série mensal contínua (13 meses) preenchendo zeros
      const mAbMap = new Map(mAb.map(r => [trim(r.ym), N(r.n)]));
      const mEncMap = new Map(mEnc.map(r => [trim(r.ym), N(r.n)]));
      const serieMensal = [];
      for (let i = 12; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const ym = `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
        serieMensal.push({ ym, label: `${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`, abertas: mAbMap.get(ym) || 0, encerradas: mEncMap.get(ym) || 0 });
      }

      // comparativo anual
      const aAbMap = new Map(aAb.map(r => [trim(r.ano), N(r.n)]));
      const aEncMap = new Map(aEnc.map(r => [trim(r.ano), N(r.n)]));
      const comparativoAnual = [];
      for (let y = now.getFullYear() - 5; y <= now.getFullYear(); y++) {
        comparativoAnual.push({ ano: String(y), abertas: aAbMap.get(String(y)) || 0, encerradas: aEncMap.get(String(y)) || 0 });
      }

      const diaParse = (s) => { s = trim(s); return s.length === 8 ? new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : null; };
      const emAberto = wip.map(w => {
        const emi = diaParse(w.emissao);
        const dias = emi ? Math.floor((now - emi) / 86400000) : null;
        const q = N(w.quant), qje = N(w.qje);
        return {
          num: trim(w.num), produto: trim(w.produto), descricao: descMap.get(trim(w.produto)) || '',
          emissao: trim(w.emissao), diasEmAberto: dias, quant: q, produzido: qje,
          progresso: q > 0 ? Math.min(100, Math.round((qje / q) * 100)) : 0
        };
      });

      const mesAtual = serieMensal[serieMensal.length - 1];
      const mesAnterior = serieMensal[serieMensal.length - 2] || { abertas: 0, encerradas: 0 };
      const mesAnoPassado = serieMensal[0]; // 12 meses atrás

      return res.json({
        emAbertoAgora: N(emAbertoRow[0] && emAbertoRow[0].n),
        hoje: { abertas: N(hojeAb[0] && hojeAb[0].n), encerradas: N(hojeEnc[0] && hojeEnc[0].n) },
        mesAtual, mesAnterior, mesAnoPassado,
        tempoMedioDias: tempo[0] && tempo[0].dias != null ? +N(tempo[0].dias).toFixed(1) : null,
        serieMensal, comparativoAnual, emAberto,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro producao/dashboard-op:', err);
      return res.status(500).json({ message: 'Erro ao gerar painel de OPs: ' + err.message });
    }
  }
});
