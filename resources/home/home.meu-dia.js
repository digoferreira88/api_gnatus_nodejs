// GET /home/meu-dia
//
// Caixa de entrada única da home: agrega as PENDÊNCIAS DO PRÓPRIO usuário nos
// módulos a que ele tem acesso. Cada fonte é checada só se o usuário tem a
// permissão do módulo — ninguém vê pendência de outro setor (o corte é por
// perm + pelo próprio usuário na query). Fase 1: Cobrança + Aprovações SC/PC.
// (Liberação financeira e outros entram em fase seguinte.)

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/meu-dia',

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const itens = [];
    try {
      const permRows = await Pg.connectAndQuery(
        `SELECT id_permissao FROM tab_intranet_usr_permissoes WHERE id_user = @id`, { id: user.ID });
      const perms = new Set(permRows.map(p => Number(p.id_permissao)));
      const has = (...ps) => perms.has(0) || ps.some(p => perms.has(p));

      // 1) Cobrança — ações de follow-up pendentes (mesma query do acoes-resumo)
      if (has(9001, 9002, 9003)) {
        try {
          const base = `data_promessa IS NOT NULL AND resultado IN ('PROMESSA_PAGAMENTO','ACORDO_FECHADO') AND concluido = false`;
          const r = (await Pg.connectAndQuery(
            `SELECT COUNT(*) FILTER (WHERE ${base}) pend,
                    COUNT(*) FILTER (WHERE ${base} AND data_promessa < CURRENT_DATE) atras
               FROM tab_cobranca_acao WHERE id_user = @uid`, { uid: user.ID }))[0] || {};
          const pend = Number(r.pend || 0), atras = Number(r.atras || 0);
          if (pend > 0) itens.push({
            id: 'cobranca', n: pend,
            sev: atras > 0 ? 'crit' : 'info',
            title: 'Ações de cobrança pendentes',
            meta: 'Cobrança · agendadas por você' + (atras > 0 ? ` · ${atras} atrasada(s)` : ''),
            tag: atras > 0 ? 'Atrasada' : 'Hoje',
            path: '/cobranca/minhas-acoes'
          });
        } catch (e) { console.warn('meu-dia cobranca:', e.message); }
      }

      // 2) Aprovações — SC/PC pendentes na alçada do usuário (contagem enxuta do
      //    aprovacoes.pendentes: SCR '02' não liberado, nomeado ou via grupo,
      //    excluindo docs já 'L' no cabeçalho — o "fantasma").
      if (has(13001)) {
        const cod = trim(user.CODIGO_PROTHEUS);
        if (cod) {
          try {
            const excl = `
              AND NOT (
                ( scr.CR_TIPO='SC'
                  AND EXISTS (SELECT 1 FROM SC1010 h WITH (NOLOCK) WHERE h.C1_FILIAL=scr.CR_FILIAL AND h.C1_NUM=scr.CR_NUM AND h.D_E_L_E_T_<>'*')
                  AND NOT EXISTS (SELECT 1 FROM SC1010 h WITH (NOLOCK) WHERE h.C1_FILIAL=scr.CR_FILIAL AND h.C1_NUM=scr.CR_NUM AND h.D_E_L_E_T_<>'*' AND h.C1_APROV<>'L') )
                OR
                ( scr.CR_TIPO IN ('PC','IP')
                  AND EXISTS (SELECT 1 FROM SC7010 h WITH (NOLOCK) WHERE h.C7_FILIAL=scr.CR_FILIAL AND h.C7_NUM=scr.CR_NUM AND h.D_E_L_E_T_<>'*')
                  AND NOT EXISTS (SELECT 1 FROM SC7010 h WITH (NOLOCK) WHERE h.C7_FILIAL=scr.CR_FILIAL AND h.C7_NUM=scr.CR_NUM AND h.D_E_L_E_T_<>'*' AND h.C7_CONAPRO<>'L') ) )`;
            const r = (await Protheus.connectAndQuery(`
              SELECT COUNT(*) total FROM (
                SELECT DISTINCT RTRIM(scr.CR_TIPO) tipo, RTRIM(scr.CR_NUM) num
                  FROM SCR010 scr WITH (NOLOCK)
                 WHERE scr.D_E_L_E_T_<>'*' AND scr.CR_FILIAL='01' AND scr.CR_STATUS='02'
                   AND RTRIM(ISNULL(scr.CR_LIBAPRO,''))='' AND scr.CR_TIPO IN ('SC','PC','IP')
                   AND ( scr.CR_USER=@cod
                         OR ( RTRIM(ISNULL(scr.CR_USER,''))=''
                              AND EXISTS (SELECT 1 FROM SAL010 sal WITH (NOLOCK)
                                           WHERE sal.D_E_L_E_T_<>'*' AND sal.AL_FILIAL='01'
                                             AND sal.AL_COD=scr.CR_GRUPO AND sal.AL_USER=@cod) ) )
                   ${excl}
              ) t`, { cod }))[0] || {};
            const total = Number(r.total || 0);
            if (total > 0) itens.push({
              id: 'aprovacoes', n: total, sev: 'crit',
              title: 'Solicitações aguardando sua aprovação',
              meta: 'Aprovações · SC / PC na sua alçada',
              tag: 'Prazo', path: '/compras/aprovacoes'
            });
          } catch (e) { console.warn('meu-dia aprovacoes:', e.message); }
        }
      }

      // ordena por severidade (crit → warn → info)
      const ord = { crit: 0, warn: 1, info: 2 };
      itens.sort((a, b) => ord[a.sev] - ord[b.sev]);

      return res.json({ itens, total: itens.length, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('home/meu-dia:', err);
      return res.status(500).json({ message: 'Erro ao carregar suas pendências.' });
    }
  }
});
