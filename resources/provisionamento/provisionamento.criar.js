// Cria usuário no AD + opcionalmente no M365 (com licença).
//
// Body:
// {
//   nomeCompleto, primeiroNome, sobrenome,
//   sAMAccountName, upn, mail, senha,
//   ou (DN da OU AD), gruposAd: [DN],
//   departamento, cargo, telefone, descricao,
//   criarM365 (bool), licencaSkuId (string), gruposM365: [id]
// }
//
// Rastreabilidade: cada etapa é logada em tab_provisionamento_log com sucesso/erro.
// Sem rollback automático — se algo falhar parcialmente, a UI mostra o que foi feito
// e o admin completa manualmente.

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
  route: '/usuario',

  handler: async (req, res) => {
    const { Pg, Ad, M365 } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) {
      return res.status(403).json({ message: 'Sem permissão (1029 - Provisionamento).' });
    }

    const b = req.body || {};
    const nomeCompleto = trim(b.nomeCompleto);
    const primeiroNome = trim(b.primeiroNome) || nomeCompleto.split(' ')[0];
    const sobrenome    = trim(b.sobrenome) || nomeCompleto.split(' ').slice(1).join(' ');
    const sAM          = trim(b.sAMAccountName).toLowerCase();
    const upn          = trim(b.upn).toLowerCase();
    const mail         = trim(b.mail).toLowerCase() || upn;
    const senhaM365    = String(b.senha || '');
    // AD usa senha padrão fixa (configurável via env). User troca no 1º login.
    const senhaAd      = process.env.AD_SENHA_PADRAO || 'Mudar@123';
    const ou           = trim(b.ou);
    const gruposAd     = Array.isArray(b.gruposAd) ? b.gruposAd : [];
    const departamento = trim(b.departamento);
    const cargo        = trim(b.cargo);
    const telefone     = trim(b.telefone);
    const descricao    = trim(b.descricao);
    const criarM365    = !!b.criarM365;
    const licencaSkuId = trim(b.licencaSkuId);
    const gruposM365   = Array.isArray(b.gruposM365) ? b.gruposM365 : [];

    // Validações básicas
    if (!nomeCompleto) return res.status(400).json({ message: 'Nome completo é obrigatório.' });
    if (!sAM || sAM.length > 20) return res.status(400).json({ message: 'sAMAccountName inválido (max 20 chars).' });
    if (!/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(upn)) return res.status(400).json({ message: 'UPN/email inválido.' });
    if (criarM365 && senhaM365.length < 8) return res.status(400).json({ message: 'Senha M365 precisa ter pelo menos 8 caracteres.' });
    if (!ou) return res.status(400).json({ message: 'OU de destino é obrigatória.' });
    if (criarM365 && !licencaSkuId) return res.status(400).json({ message: 'Selecione uma licença M365.' });

    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    const etapas = [];     // cada etapa = { passo, ok, detalhe }
    let userDnAd = null;
    let userIdM365 = null;
    let criouAd = false, criouM365 = false, atribuiuLicenca = false;

    const log = (passo, ok, detalhe) => {
      etapas.push({ passo, ok, detalhe });
      console.log(`[PROVIS ${ok ? '✓' : '✗'}] ${passo} — ${detalhe || ''}`);
    };

    // ================== 1. AD: verifica duplicidade ==================
    try {
      const existDn = await Ad.userExists(sAM);
      if (existDn) {
        log('AD: verificar duplicidade', false, `Já existe usuário ${sAM} em ${existDn}`);
        return res.status(409).json({
          message: `Já existe usuário no AD com sAMAccountName "${sAM}".`,
          etapas
        });
      }
      log('AD: verificar duplicidade', true, 'sAMAccountName disponível');
    } catch (e) {
      log('AD: verificar duplicidade', false, e.message);
      return res.status(502).json({ message: 'Falha ao consultar AD: ' + e.message, etapas });
    }

    // ================== 2. AD: criar usuário ==================
    try {
      const r = await Ad.createUser({
        ou, sAMAccountName: sAM, upn, displayName: nomeCompleto,
        givenName: primeiroNome, sn: sobrenome || primeiroNome, mail,
        password: senhaAd, departamento, cargo, telefone, descricao
      });
      userDnAd = r.dn;
      criouAd = true;
      log('AD: criar usuário', true, `DN ${userDnAd}`);
      r.erros.forEach(err => log('AD: ajuste pós-criação', false, err));
    } catch (e) {
      log('AD: criar usuário', false, e.message);
      // Falhou aqui - aborta tudo
      return await finalizar(false, 'Falha ao criar no AD: ' + e.message);
    }

    // ================== 3. AD: adicionar a grupos ==================
    if (gruposAd.length) {
      try {
        const r = await Ad.addToGroups(userDnAd, gruposAd);
        const okCount = r.filter(x => x.ok).length;
        log('AD: adicionar a grupos', okCount === r.length, `${okCount}/${r.length} grupos OK`);
        r.filter(x => !x.ok).forEach(x => log('  → grupo', false, `${x.group}: ${x.erro}`));
      } catch (e) {
        log('AD: adicionar a grupos', false, e.message);
      }
    }

    // ================== 4. M365: criar usuário ==================
    if (criarM365) {
      try {
        const r = await M365.createUser({
          displayName: nomeCompleto,
          mailNickname: sAM,
          upn,
          password: senhaM365,
          givenName: primeiroNome,
          surname: sobrenome,
          jobTitle: cargo,
          department: departamento,
          mobilePhone: telefone
        });
        userIdM365 = r.id;
        criouM365 = true;
        log('M365: criar usuário', true, `id=${userIdM365}`);
      } catch (e) {
        log('M365: criar usuário', false, e.statusCode ? `${e.statusCode} ${e.message}` : e.message);
      }
    }

    // ================== 5. M365: atribuir licença ==================
    if (criouM365 && licencaSkuId) {
      try {
        await M365.assignLicense(userIdM365, licencaSkuId);
        atribuiuLicenca = true;
        log('M365: atribuir licença', true, `SKU ${licencaSkuId}`);
      } catch (e) {
        log('M365: atribuir licença', false, e.statusCode ? `${e.statusCode} ${e.message}` : e.message);
      }
    }

    // ================== 6. M365: grupos ==================
    if (criouM365 && gruposM365.length) {
      let okCount = 0;
      for (const gid of gruposM365) {
        try { await M365.addUserToGroup(userIdM365, gid); okCount++; }
        catch (e) { log(`M365: grupo ${gid}`, false, e.message); }
      }
      log('M365: adicionar a grupos', okCount === gruposM365.length, `${okCount}/${gruposM365.length} OK`);
    }

    return await finalizar(true, null);

    // ============ helper de finalização (grava log + responde) ============
    async function finalizar(sucesso, erroFinal) {
      try {
        await Pg.connectAndQuery(
          `INSERT INTO tab_provisionamento_log
             (id_user_executor, nome_completo, upn, ou, grupos_ad, licenca_m365,
              criou_ad, criou_m365, atribuiu_licenca, sucesso_geral, detalhes, erro, ip_origem)
           VALUES (@uid, @nome, @upn, @ou, @gad, @lic, @cad, @cm365, @alic, @suc, @det, @err, @ip)`,
          {
            uid: user.ID, nome: nomeCompleto, upn, ou,
            gad: gruposAd.join(', ') || null,
            lic: licencaSkuId || null,
            cad: criouAd, cm365: criouM365, alic: atribuiuLicenca,
            suc: sucesso, det: JSON.stringify(etapas), err: erroFinal,
            ip
          }
        );
      } catch (e) { console.error('Falha ao gravar log:', e.message); }

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'Provisionamento',
        acao: 'CREATE', severidade: sucesso ? 'CRITICO' : 'ALERTA',
        req, entidade: 'usuario_ad_m365', entidadeId: upn,
        descricao: `${sucesso ? 'Provisionou' : 'Falhou ao provisionar'} usuário "${nomeCompleto}" (${upn}) — AD:${criouAd ? 'OK' : '–'} M365:${criouM365 ? 'OK' : '–'} Licença:${atribuiuLicenca ? 'OK' : '–'}`,
        meta: { upn, nome: nomeCompleto, ou, gruposAd, criouAd, criouM365, atribuiuLicenca, erro: erroFinal }
      });

      const resp = {
        ok: sucesso, etapas,
        userDnAd, userIdM365,
        criouAd, criouM365, atribuiuLicenca
      };
      if (erroFinal) resp.message = erroFinal;
      return res.status(sucesso ? 200 : 502).json(resp);
    }
  }
});
