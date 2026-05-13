// POST /compras/sc-criar
//
// Cria uma SC no Protheus via REST custom Develsoft. Solicitante = email do
// usuario logado. Loga tudo em tab_sc_intranet_log + audita CRITICO.
//
// Body: {
//   data_necessaria: 'YYYY-MM-DD' (obrigatorio),
//   observacao?: string,
//   itens: [{ produto, quantidade, local?, centro_custo, observacao?, fornecedor?, loja? }, ...],
//   anexos?: [{ nome, descricao?, base64, item? }, ...]
// }
//
// Anexos: max 10 arquivos · 10MB total · base64 do conteudo cru (sem prefixo
// data:...;base64,). Item omitido = anexo do cabecalho; com item = anexo do
// item N.
//
// Permissao 4004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4004]);
const Auditoria = require('../../services/auditoria');
const ProtheusSolicCompra = require('../../services/protheusSolicCompra');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// 'YYYY-MM-DD' -> 'YYYYMMDD'
const toProtDate = (iso) => {
  const s = String(iso || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

module.exports = (app) => ({
  verb: 'post',
  route: '/sc-criar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    const dataNecessaria = toProtDate(b.data_necessaria);
    if (!dataNecessaria) {
      return res.status(400).json({ message: 'data_necessaria obrigatoria (YYYY-MM-DD).' });
    }
    if (!Array.isArray(b.itens) || b.itens.length === 0) {
      return res.status(400).json({ message: 'Pelo menos 1 item eh obrigatorio.' });
    }
    if (b.itens.length > 50) {
      return res.status(400).json({ message: 'Maximo de 50 itens por SC.' });
    }

    // Valida itens (1 round antes de bater no Protheus)
    for (let i = 0; i < b.itens.length; i++) {
      const it = b.itens[i];
      if (!trim(it.produto))      return res.status(400).json({ message: `Item ${i + 1}: produto obrigatorio.` });
      if (N(it.quantidade) <= 0)  return res.status(400).json({ message: `Item ${i + 1}: quantidade deve ser > 0.` });
      if (!trim(it.centro_custo)) return res.status(400).json({ message: `Item ${i + 1}: centro de custo obrigatorio.` });
    }

    // Valida anexos (opcional): max 10 arquivos, 10MB total em base64
    const anexos = Array.isArray(b.anexos) ? b.anexos : [];
    if (anexos.length > 10) {
      return res.status(400).json({ message: 'Maximo de 10 anexos por SC.' });
    }
    let tamanhoTotal = 0;
    for (let i = 0; i < anexos.length; i++) {
      const a = anexos[i];
      if (!trim(a.nome))   return res.status(400).json({ message: `Anexo ${i + 1}: nome obrigatorio.` });
      if (!trim(a.base64)) return res.status(400).json({ message: `Anexo ${i + 1}: conteudo (base64) obrigatorio.` });
      tamanhoTotal += a.base64.length;
    }
    // base64 expande ~33%; 10MB binario ~= 13.3M chars base64
    if (tamanhoTotal > 14 * 1024 * 1024) {
      return res.status(413).json({ message: `Anexos somam mais de 10MB. Reduza o tamanho dos arquivos.` });
    }

    const operadorEmail = trim(user.EMAIL) || `id_${user.ID}`;
    const operadorNome  = trim(user.NOME)  || operadorEmail;

    // Monta payload Protheus
    const payload = {
      filial: '01',
      solicitante: operadorEmail,
      data_emissao: undefined,  // deixa o service preencher com hoje
      data_necessaria: dataNecessaria,
      observacao: trim(b.observacao) || `SC via Intranet por ${operadorNome}`,
      itens: b.itens.map(it => ({
        produto:      trim(it.produto),
        quantidade:   N(it.quantidade),
        local:        trim(it.local) || '01',
        centro_custo: trim(it.centro_custo),
        observacao:   trim(it.observacao),
        fornecedor:   trim(it.fornecedor),
        loja:         trim(it.loja)
      })),
      ...(anexos.length > 0 ? {
        anexos: anexos.map(a => ({
          nome: trim(a.nome),
          descricao: trim(a.descricao) || trim(a.nome),
          base64: trim(a.base64),
          ...(a.item ? { item: N(a.item) } : {})
        }))
      } : {})
    };

    let logId = null;
    try {
      // 1) Chama Protheus
      const r = await ProtheusSolicCompra.criarSC(payload);

      // 2) Grava log (sucesso ou falha)
      try {
        const logRes = await Pg.connectAndQuery(`
          INSERT INTO tab_sc_intranet_log (
            id_user, usuario_email, usuario_nome,
            payload, response, http_status,
            sc_numero, status, mensagem_erro, duracao_ms
          ) VALUES (
            @uid, @email, @nome,
            @payload::jsonb, @response::jsonb, @httpStatus,
            @scNum, @status, @mensagem, @duracao
          )
          RETURNING id`,
          {
            uid: user.ID,
            email: operadorEmail,
            nome: operadorNome,
            payload: JSON.stringify(payload),
            response: JSON.stringify(r.body),
            httpStatus: r.httpStatus,
            scNum: r.sc_numero,
            status: r.status,
            mensagem: r.mensagem ? r.mensagem.slice(0, 500) : null,
            duracao: r.duracao_ms
          }
        );
        logId = logRes[0]?.id;
      } catch (e) {
        console.error('sc-criar: falha ao logar', e.message);
      }

      // 3) Auditoria
      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'SolicitarCompra',
        acao: 'CRIAR_SC', severidade: r.status === 'SUCESSO' ? 'CRITICO' : 'ALERTA',
        req, entidade: 'sc', entidadeId: r.sc_numero || `log_${logId}`,
        descricao: r.status === 'SUCESSO'
          ? `Criou SC ${r.sc_numero} no Protheus (${b.itens.length} item(ns), ${anexos.length} anexo(s), solicitante ${operadorEmail})`
          : `Falha ao criar SC: ${r.mensagem || r.status} (${b.itens.length} item(ns) tentado)`,
        meta: {
          status: r.status,
          sc_numero: r.sc_numero,
          httpStatus: r.httpStatus,
          qt_itens: b.itens.length,
          qt_anexos: anexos.length,
          anexos_gravados: r.anexos_gravados,
          duracao_ms: r.duracao_ms,
          inconsistencias: r.body?.INCONSISTENCIAS?.slice(0, 5)
        }
      });

      // 4) Devolve pra UI
      return res.json({
        status: r.status,
        sc_numero: r.sc_numero,
        mensagem: r.mensagem,
        httpStatus: r.httpStatus,
        inconsistencias: r.body?.INCONSISTENCIAS || [],
        anexos_gravados: r.anexos_gravados || 0,
        log_id: logId,
        duracao_ms: r.duracao_ms
      });
    } catch (err) {
      console.error('sc-criar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
