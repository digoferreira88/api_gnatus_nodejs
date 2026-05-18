// Aprova SC ou Pedido (IP) via API REST do Protheus.
//
// Endpoint custom Develsoft:
//   POST {PROTHEUS_API_URL}/AprovaCompras/aprovar
//   Auth: Basic (credenciais em .env — NUNCA commitar credenciais reais)
//   Body: { tipo, filial, numero, login, observacao }
//
// Mapeamento tipo:
//   - "SC" (Solicitação de Compra)  → enviado como "SC"
//   - "PC" (Pedido de Compra)       → enviado como "IP" (Item de Pedido)
//
// Login do aprovador: SYS_USR.USR_CODIGO buscado pelo CODIGO_PROTHEUS (USR_ID)
// do usuário logado.
//
// Variáveis .env obrigatórias:
//   PROTHEUS_API_URL    PROTHEUS_API_USER    PROTHEUS_API_PASS    PROTHEUS_API_FILIAL

const trim = (v) => String(v || '').trim();
const tiposValidos = new Set(['SC', 'PC']);
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([13001]);

module.exports = (app) => ({
  verb: 'post',
  route: '/:tipo/:numero',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const codProth = trim(user.CODIGO_PROTHEUS);
    if (!codProth) return res.status(403).json({ message: 'Usuário sem código Protheus cadastrado.' });

    const tipoIntranet = trim(req.params.tipo).toUpperCase();
    const numero       = trim(req.params.numero);
    const justificativa = trim(req.body?.justificativa);

    if (!tiposValidos.has(tipoIntranet)) return res.status(400).json({ message: 'Tipo deve ser SC ou PC.' });
    if (!numero)                          return res.status(400).json({ message: 'Número é obrigatório.' });

    const apiUrl  = process.env.PROTHEUS_API_URL;
    const apiUser = process.env.PROTHEUS_API_USER;
    const apiPass = process.env.PROTHEUS_API_PASS;
    const filial  = process.env.PROTHEUS_API_FILIAL || '01';
    const path    = process.env.PROTHEUS_API_PATH_APROVAR || '/AprovaCompras/aprovar';
    const ip      = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';

    // Mapeia PC → IP (no Protheus a aprovação de pedido usa "IP" no header)
    const tipoApi = tipoIntranet === 'PC' ? 'IP' : 'SC';

    const logar = async (sucesso, resposta) => {
      try {
        await Pg.connectAndQuery(
          `INSERT INTO tab_aprovacao_log
             (id_user, codigo_protheus, tipo_doc, numero_doc, acao, justificativa, sucesso, resposta_protheus, ip_origem)
           VALUES (@uid, @cod, @tipo, @num, 'APROVAR', @just, @suc, @resp, @ip)`,
          { uid: user.ID, cod: codProth, tipo: tipoIntranet, num: numero, just: justificativa || null, suc: !!sucesso, resp: resposta || null, ip }
        );
      } catch (e) { console.error('Falha ao gravar log:', e.message); }
    };

    if (!apiUrl || !apiUser || !apiPass) {
      const msg = 'API Protheus não configurada (PROTHEUS_API_URL/USER/PASS no .env).';
      await logar(false, msg);
      return res.status(503).json({ ok: false, message: msg, configured: false });
    }

    // ===== Pre-check de elegibilidade =====
    // Antes de bater no Protheus, confere que ESTE usuario eh aprovador valido
    // pra ESTE documento especifico. Sem isso, qualquer user com perm 13001
    // poderia aprovar SC/PC de qualquer outro aprovador (cross-BU).
    // Admin (perm 0) bypass — auditoria abrange.
    const admCheck = await Pg.connectAndQuery(
      `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao = 0 LIMIT 1`,
      { id: user.ID }
    );
    const isAdmin = admCheck.length > 0;

    if (!isAdmin) {
      // SCR no Protheus: tipo SC ou IP (para PC), status 02, sem aprovacao
      const tipoFiltro = tipoIntranet === 'PC' ? 'IP' : 'SC';
      const elegivel = await Protheus.connectAndQuery(`
        SELECT TOP 1 1 elegivel
          FROM SCR010 scr WITH (NOLOCK)
          LEFT JOIN SAL010 sal WITH (NOLOCK)
            ON sal.AL_FILIAL = '01' AND sal.AL_COD = scr.CR_GRUPO
           AND sal.AL_USER = @cod AND sal.D_E_L_E_T_ <> '*'
         WHERE scr.D_E_L_E_T_ <> '*'
           AND scr.CR_FILIAL = '01'
           AND scr.CR_NUM = @num
           AND scr.CR_TIPO = @tipo
           AND scr.CR_STATUS = '02'
           AND RTRIM(ISNULL(scr.CR_LIBAPRO, '')) = ''
           AND (scr.CR_USER = @cod OR sal.AL_USER = @cod)`,
        { cod: codProth, num: numero, tipo: tipoFiltro }
      );
      if (!elegivel.length) {
        const msg = `Sem alcada pra aprovar ${tipoIntranet} ${numero} (nao consta na sua fila).`;
        await logar(false, msg);
        Auditoria.registrar(app, {
          modulo: 'Compras', submodulo: 'Aprovacoes', acao: 'APPROVE_DENIED', severidade: 'ALERTA',
          req, entidade: tipoIntranet === 'SC' ? 'sc_aprovacao' : 'pc_aprovacao', entidadeId: numero,
          descricao: `BLOQUEADO: usuario codProth=${codProth} tentou aprovar ${tipoIntranet} ${numero} sem alcada`,
          meta: { tipo: tipoIntranet, numero, codProth }
        });
        return res.status(403).json({ ok: false, message: msg });
      }
    }

    // Resolve o login (USR_CODIGO) a partir do CODIGO_PROTHEUS (USR_ID)
    let login = '';
    try {
      const r = await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(USR_CODIGO) login FROM SYS_USR WHERE USR_ID = @cod`,
        { cod: codProth }
      );
      login = trim(r[0]?.login);
    } catch (e) { console.error('Erro ao buscar USR_CODIGO:', e.message); }
    if (!login) {
      const msg = `Usuário código ${codProth} não localizado em SYS_USR (USR_CODIGO vazio).`;
      await logar(false, msg);
      return res.status(400).json({ ok: false, message: msg });
    }

    const url = apiUrl.replace(/\/$/, '') + path;
    const body = {
      tipo: tipoApi,
      filial,
      numero,
      login,
      observacao: justificativa || `Aprovado via Intranet GNATUS por ${trim(user.NOME)}`
    };

    try {
      const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body: JSON.stringify(body)
      });
      const txt = await r.text();
      const ok = r.ok;
      await logar(ok, `[${r.status}] ${txt.slice(0, 1000)}`);
      if (!ok) {
        Auditoria.registrar(app, {
          modulo: 'Compras', submodulo: 'Aprovacoes', acao: 'APPROVE_FAIL', severidade: 'ALERTA',
          req, entidade: tipoIntranet === 'SC' ? 'sc_aprovacao' : 'pc_aprovacao', entidadeId: numero,
          descricao: `Falha ao aprovar ${tipoIntranet} ${numero} (Protheus ${r.status})`,
          meta: { tipo: tipoIntranet, numero, justificativa, http: r.status }
        });
        return res.status(502).json({ ok: false, message: 'Protheus retornou erro.', status: r.status, body: txt.slice(0, 500) });
      }
      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'Aprovacoes', acao: 'APPROVE', severidade: 'CRITICO',
        req, entidade: tipoIntranet === 'SC' ? 'sc_aprovacao' : 'pc_aprovacao', entidadeId: numero,
        descricao: `Aprovou ${tipoIntranet} ${numero}${justificativa ? ` — "${justificativa.slice(0, 80)}"` : ''}`,
        meta: { tipo: tipoIntranet, numero, justificativa }
      });
      return res.json({ ok: true, status: r.status, response: (() => { try { return JSON.parse(txt); } catch { return txt; } })() });
    } catch (err) {
      await logar(false, err.message);
      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'Aprovacoes', acao: 'APPROVE_ERROR', severidade: 'CRITICO',
        req, entidade: tipoIntranet === 'SC' ? 'sc_aprovacao' : 'pc_aprovacao', entidadeId: numero,
        descricao: `Erro ao chamar Protheus em aprovacao de ${tipoIntranet} ${numero}: ${err.message}`,
        meta: { tipo: tipoIntranet, numero, erro: err.message }
      });
      return res.status(500).json({ ok: false, message: 'Erro ao chamar Protheus: ' + err.message });
    }
  }
});
