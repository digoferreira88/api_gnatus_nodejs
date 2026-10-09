// POST /financeiro/boleto-lote/:id/enviar-protheus
//
// Envia o lote ao Protheus via REST custom Diego (services/protheusCobranca).
// Atualiza status do lote, grava lote_protheus retornado, contadores e o
// JSON completo da resposta. Audita CRITICO.
//
// Pre-condicao: lote em status 'CRIADO' (nao reenvia).
//
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const ProtheusCobranca = require('../../services/protheusCobranca');
const ProtheusCarteira = require('../../services/protheusCarteira');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

const chaveTitulo = (t) => [t.prefixo, t.numero, t.parcela, t.cliente_cod, t.cliente_loja].map(trim).join('|');

// E1_TIPO dos titulos na SE1, por chave sem o tipo. Mais de um tipo na mesma
// chave e' possivel (ex.: NF e DP de mesmo numero), por isso devolve lista.
// RA/NCC ficam de fora, como na lista de elegiveis: nunca viram boleto.
async function tiposDaSe1(Protheus, titulos) {
  const out = new Map();
  const BATCH = 80;
  for (let i = 0; i < titulos.length; i += BATCH) {
    const slice = titulos.slice(i, i + BATCH);
    const p = {};
    const ors = slice.map((t, k) => {
      p[`pf${k}`] = trim(t.prefixo); p[`nu${k}`] = trim(t.numero); p[`pa${k}`] = trim(t.parcela);
      p[`cl${k}`] = trim(t.cliente_cod); p[`lo${k}`] = trim(t.cliente_loja);
      return `(RTRIM(E1_PREFIXO)=@pf${k} AND RTRIM(E1_NUM)=@nu${k} AND RTRIM(E1_PARCELA)=@pa${k} AND RTRIM(E1_CLIENTE)=@cl${k} AND RTRIM(E1_LOJA)=@lo${k})`;
    }).join(' OR ');
    const rows = await Protheus.connectAndQuery(`
      SELECT RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela,
             RTRIM(E1_CLIENTE) cliente_cod, RTRIM(E1_LOJA) cliente_loja, RTRIM(E1_TIPO) tipo
        FROM SE1010 WITH (NOLOCK)
       WHERE D_E_L_E_T_<>'*' AND E1_FILIAL='01' AND RTRIM(E1_TIPO) NOT IN ('RA','NCC') AND (${ors})`, p);
    rows.forEach(r => {
      const k = chaveTitulo(r);
      if (!out.has(k)) out.set(k, []);
      if (!out.get(k).includes(trim(r.tipo))) out.get(k).push(trim(r.tipo));
    });
  }
  return out;
}

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-lote/:id/enviar-protheus',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido.' });
    }

    try {
      // 1) Carrega lote + valida que pode ser enviado
      const cab = await Pg.connectAndQuery(
        `SELECT * FROM tab_boleto_envio_lote WHERE id = @id`, { id }
      );
      if (!cab.length) return res.status(404).json({ message: 'Lote nao encontrado.' });
      const lote = cab[0];

      const isAdmin = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
        { uid: user.ID }
      );
      if (lote.id_user !== user.ID && !isAdmin.length) {
        return res.status(403).json({ message: 'Sem permissao pra enviar este lote.' });
      }

      if (lote.status !== 'CRIADO') {
        return res.status(409).json({
          message: `Lote ja esta em status "${lote.status}". So eh possivel enviar lotes em status CRIADO.`,
          status_atual: lote.status,
          lote_protheus: lote.lote_protheus
        });
      }

      // 2) Carrega titulos
      const titulos = await Pg.connectAndQuery(
        `SELECT prefixo, numero, parcela, tipo, cliente_cod, cliente_loja
           FROM tab_boleto_envio_lote_titulo WHERE id_lote = @id`, { id }
      );
      if (!titulos.length) {
        return res.status(400).json({ message: 'Lote sem titulos.' });
      }

      // 2.1) Tipo real do titulo. O gerar-bordero do Diego faz DbSeek na chave
      // completa (prefixo+numero+parcela+TIPO); o antigo default 'NF' fazia um
      // titulo BOL (alfanumerico, ex.: FT/OMN167488/06) voltar
      // TITULO_NAO_ENCONTRADO e ficar fora do borderô. Sem tipo no lote, busca
      // na SE1; se nao houver exatamente um, para em vez de adivinhar.
      const semTipo = titulos.filter(t => !trim(t.tipo));
      if (semTipo.length) {
        const tipos = await tiposDaSe1(app.services.Protheus, semTipo);
        const pendentes = [];
        for (const t of semTipo) {
          const achados = tipos.get(chaveTitulo(t)) || [];
          if (achados.length === 1) t.tipo = achados[0];
          else pendentes.push([trim(t.prefixo), trim(t.numero), trim(t.parcela)].filter(Boolean).join('/') + (achados.length ? ` (tipos ${achados.join(', ')})` : ' (não está na SE1)'));
        }
        if (pendentes.length) {
          return res.status(409).json({
            codigo_erro: 'TIPO_INDEFINIDO',
            message: `Não deu para identificar o tipo de ${pendentes.length} título(s) na SE1: ${pendentes.slice(0, 10).join('; ')}${pendentes.length > 10 ? '…' : ''}. Recrie o lote a partir da lista de títulos.`,
            titulos: pendentes
          });
        }
      }

      // 3) Chama Protheus via service
      const operadorEmail = trim(user.EMAIL) || `id_${user.ID}`;
      const observacao = `Lote #${id} via Intranet GNATUS por ${operadorEmail}`;
      const r = await ProtheusCobranca.gerarBordero({
        filial: '01',
        banco: trim(lote.banco_cod),
        agencia: trim(lote.banco_agencia),
        conta: trim(lote.banco_conta),
        operador: operadorEmail,
        observacao,
        titulos: titulos.map(t => ({
          prefixo: trim(t.prefixo), numero: trim(t.numero), parcela: trim(t.parcela),
          tipo: trim(t.tipo),
          cliente: trim(t.cliente_cod), loja: trim(t.cliente_loja)
        }))
      });

      const body = r.body || {};
      const okGeral = !!body.ok;
      const qtProc = N(body.qtd_processados);
      const qtRej  = N(body.qtd_rejeitados);
      const loteProth = trim(body.lote);  // se Diego devolver, gravamos

      // 4) Decide novo status
      // - Sucesso real (ok=true E qtd_processados>0): ENVIADO_PROTHEUS, mesmo com rejeicoes parciais
      // - "Nada processado" (ok=true mas qtd_processados=0 — Protheus rejeitou
      //   TODOS os titulos): nao eh sucesso nem erro de sistema. Mantem o lote
      //   CRIADO (reenviavel) e avisa o operador com a mensagem.
      // - Falha geral (HTTP nao-2xx ou body.ok=false): ERRO_PROTHEUS
      const sucesso = okGeral && qtProc > 0;
      const nadaProcessado = okGeral && qtProc === 0;
      const novoStatus = sucesso ? 'ENVIADO_PROTHEUS' : (nadaProcessado ? 'CRIADO' : 'ERRO_PROTHEUS');

      await Pg.connectAndQuery(`
        UPDATE tab_boleto_envio_lote
           SET status            = @st,
               lote_protheus     = @lp,
               enviado_em        = NOW(),
               enviado_por_email = @em,
               qt_processados    = @qp,
               qt_rejeitados     = @qr,
               protheus_resposta = @resp::jsonb,
               atualizado_em     = NOW()
         WHERE id = @id`,
        {
          id, st: novoStatus,
          lp: loteProth || null,
          em: operadorEmail,
          qp: qtProc, qr: qtRej,
          resp: JSON.stringify({ httpStatus: r.httpStatus, ...body })
        }
      );

      // 4.1) Carteira simples: o gerar-bordero do Diego deixa E1_SITUACA='0'; o
      // padrão da empresa é '1'. Corrige os títulos DESTE borderô (escrita SE1
      // escopada e transacional — services/protheusCarteira). Não-fatal: o
      // borderô já foi criado; se falhar, só loga/audita.
      let carteira = null;
      if (sucesso && loteProth) {
        try {
          carteira = await ProtheusCarteira.marcarCarteiraSimples(app.services.Protheus, [loteProth]);
          if (!carteira.ok) console.warn(`[boleto-lote ${id}] carteira-simples falhou:`, carteira.msg);
        } catch (e) {
          console.warn(`[boleto-lote ${id}] carteira-simples erro:`, e.message);
          carteira = { ok: false, atualizados: 0, msg: e.message };
        }
      }

      // 5) Auditoria
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'BORDERO_PROTHEUS', severidade: sucesso ? 'CRITICO' : 'ALERTA',
        req, entidade: 'boleto_lote', entidadeId: String(id),
        descricao: sucesso
          ? `Enviou lote #${id} ao Protheus (banco ${lote.banco_cod}, ${qtProc}/${titulos.length} OK${qtRej ? `, ${qtRej} rejeitados` : ''}${loteProth ? `, bordero ${loteProth}` : ''})`
          : nadaProcessado
            ? `Nada processado: lote #${id} — Protheus rejeitou todos os ${qtRej} titulo(s) (banco ${lote.banco_cod}). Lote mantido como CRIADO pra reenvio.`
            : `FALHA ao enviar lote #${id} ao Protheus (HTTP ${r.httpStatus}, ${body.codigo_erro || '?'})`,
        meta: {
          id_lote: id,
          banco: lote.banco_cod, qt_titulos: titulos.length,
          qt_processados: qtProc, qt_rejeitados: qtRej,
          lote_protheus: loteProth,
          carteira_simples_ok: carteira ? carteira.ok : null,
          carteira_simples_atualizados: carteira ? carteira.atualizados : null,
          httpStatus: r.httpStatus, codigo_erro: body.codigo_erro
        }
      });

      return res.json({
        ok: sucesso,
        nada_processado: nadaProcessado,
        status: novoStatus,
        message: nadaProcessado
          ? 'Nada processado — o Protheus rejeitou todos os títulos. Verifique os motivos abaixo e reenvie o lote.'
          : undefined,
        lote_protheus: loteProth || null,
        qt_processados: qtProc,
        qt_rejeitados: qtRej,
        carteira_simples: carteira,  // { ok, atualizados } — E1_SITUACA 0→1 nos títulos do borderô
        httpStatus: r.httpStatus,
        protheus: body  // inclui detalhes[] com chave de cada titulo + status
      });
    } catch (err) {
      console.error('boleto-lote enviar-protheus:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
