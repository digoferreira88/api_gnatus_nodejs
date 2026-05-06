// Desliga colaborador: bloqueia M365 + remove TODAS licenças + desabilita AD
//
// Body: { m365Id?, adDn?, upn? } — pelo menos um identificador
// Não deleta nada — apenas desabilita/bloqueia (reversível).

const trim = (v) => String(v || '').trim();
const Auditoria = require('../../services/auditoria');

const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT id_permissao FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, 1029)`,
    { id: idUser }
  );
  return r.length > 0;
};

module.exports = (app) => ({
  verb: 'post',
  route: '/desligar',

  handler: async (req, res) => {
    const { Pg, Ad, M365 } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) {
      return res.status(403).json({ message: 'Sem permissão (1029 - Provisionamento).' });
    }

    const m365Id = trim(req.body?.m365Id);
    const adDn   = trim(req.body?.adDn);
    const upn    = trim(req.body?.upn);
    const nomeRef = trim(req.body?.nome) || upn || m365Id || adDn;

    if (!m365Id && !adDn && !upn) {
      return res.status(400).json({ message: 'Informe m365Id, adDn ou upn.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    const etapas = [];
    let bloqueouM365 = false, removeuLicencas = false, desabilitouAd = false;
    let licencasRemovidas = [];

    const log = (passo, ok, detalhe) => {
      etapas.push({ passo, ok, detalhe });
      console.log(`[DESLIG ${ok ? '✓' : '✗'}] ${passo} — ${detalhe || ''}`);
    };

    // ============== M365: remover licenças ==============
    if (m365Id || upn) {
      const idM365 = m365Id || upn;
      try {
        const r = await M365.removeAllLicenses(idM365);
        removeuLicencas = true;
        licencasRemovidas = r.skus || [];
        log('M365: remover licenças', true, r.removidas
          ? `${r.removidas} licença(s) removida(s): ${(r.skus || []).join(', ')}`
          : 'Nenhuma licença atribuída.');
      } catch (e) {
        log('M365: remover licenças', false, e.statusCode ? `${e.statusCode} ${e.message}` : e.message);
      }

      // ============== M365: bloquear conta ==============
      try {
        await M365.disableUser(idM365);
        bloqueouM365 = true;
        log('M365: bloquear conta', true, 'accountEnabled = false');
      } catch (e) {
        log('M365: bloquear conta', false, e.statusCode ? `${e.statusCode} ${e.message}` : e.message);
      }
    }

    // ============== AD: desabilitar conta ==============
    if (adDn) {
      try {
        await Ad.disableUser(adDn);
        desabilitouAd = true;
        log('AD: desabilitar conta', true, 'userAccountControl = 514');
      } catch (e) {
        log('AD: desabilitar conta', false, e.message);
      }
    } else if (upn) {
      // Tenta localizar no AD pelo UPN antes de desabilitar
      try {
        const adUser = await Ad.findUser(upn);
        if (!adUser) {
          log('AD: localizar usuário', false, `UPN ${upn} não encontrado no AD`);
        } else {
          try {
            await Ad.disableUser(adUser.dn);
            desabilitouAd = true;
            log('AD: desabilitar conta', true, `${adUser.dn} desabilitada`);
          } catch (e) {
            log('AD: desabilitar conta', false, e.message);
          }
        }
      } catch (e) {
        log('AD: localizar usuário', false, e.message);
      }
    }

    const sucesso = (bloqueouM365 || !m365Id) && desabilitouAd;

    // Log Postgres
    try {
      await Pg.connectAndQuery(
        `INSERT INTO tab_provisionamento_log
           (id_user_executor, nome_completo, upn, ou, grupos_ad, licenca_m365,
            criou_ad, criou_m365, atribuiu_licenca, sucesso_geral, detalhes, ip_origem, acao)
         VALUES (@uid, @nome, @upn, @ou, @gad, @lic, @cad, @cm365, @alic, @suc, @det, @ip, 'DESLIGAR')`,
        {
          uid: user.ID, nome: nomeRef, upn: upn || '', ou: adDn || null,
          gad: null, lic: licencasRemovidas.join(', ') || null,
          cad: desabilitouAd, cm365: bloqueouM365, alic: removeuLicencas,
          suc: sucesso, det: JSON.stringify(etapas), ip
        }
      );
    } catch (e) { console.error('Falha ao gravar log:', e.message); }

    Auditoria.registrar(app, {
      modulo: 'Tecnologia', submodulo: 'Provisionamento',
      acao: 'DISABLE', severidade: 'CRITICO',
      req, entidade: 'usuario_ad_m365', entidadeId: upn || adDn || nomeRef,
      descricao: `Desligou usuário "${nomeRef}" — M365:${bloqueouM365 ? 'OK' : '–'} AD:${desabilitouAd ? 'OK' : '–'} Licenças: ${licencasRemovidas.length}`,
      meta: { upn, adDn, bloqueouM365, removeuLicencas, desabilitouAd, licencasRemovidas, sucesso }
    });

    return res.status(sucesso ? 200 : 502).json({
      ok: sucesso,
      etapas,
      bloqueouM365, removeuLicencas, desabilitouAd,
      licencasRemovidas
    });
  }
});
