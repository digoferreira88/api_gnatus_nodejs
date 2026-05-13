// POST /financeiro/boleto-lote/:id/enviar-protheus
//
// Envia o lote ao Protheus via REST custom Develsoft (services/protheusCobranca).
// Atualiza status do lote, grava lote_protheus retornado, contadores e o
// JSON completo da resposta. Audita CRITICO.
//
// Pre-condicao: lote em status 'CRIADO' (nao reenvia).
//
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const ProtheusCobranca = require('../../services/protheusCobranca');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

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

      // 3) Chama Protheus via service
      const operadorEmail = trim(user.EMAIL) || `id_${user.ID}`;
      const observacao = `Lote #${id} via Intranet GNATUS por ${operadorEmail}`;
      const r = await ProtheusCobranca.gerarBordero({
        filial: '01',
        banco: trim(lote.banco_cod),
        operador: operadorEmail,
        observacao,
        titulos: titulos.map(t => ({
          prefixo: trim(t.prefixo), numero: trim(t.numero), parcela: trim(t.parcela),
          tipo: trim(t.tipo) || 'NF',
          cliente: trim(t.cliente_cod), loja: trim(t.cliente_loja)
        }))
      });

      const body = r.body || {};
      const okGeral = !!body.ok;
      const qtProc = N(body.qtd_processados);
      const qtRej  = N(body.qtd_rejeitados);
      const loteProth = trim(body.lote);  // se Develsoft devolver, gravamos

      // 4) Decide novo status
      // - Sucesso (HTTP 200 + body.ok=true): ENVIADO_PROTHEUS, mesmo com rejeicoes parciais
      // - Falha geral (HTTP nao-2xx ou body.ok=false): ERRO_PROTHEUS
      const novoStatus = okGeral ? 'ENVIADO_PROTHEUS' : 'ERRO_PROTHEUS';

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

      // 5) Auditoria
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'BORDERO_PROTHEUS', severidade: okGeral ? 'CRITICO' : 'ALERTA',
        req, entidade: 'boleto_lote', entidadeId: String(id),
        descricao: okGeral
          ? `Enviou lote #${id} ao Protheus (banco ${lote.banco_cod}, ${qtProc}/${titulos.length} OK${qtRej ? `, ${qtRej} rejeitados` : ''}${loteProth ? `, bordero ${loteProth}` : ''})`
          : `FALHA ao enviar lote #${id} ao Protheus (HTTP ${r.httpStatus}, ${body.codigo_erro || '?'})`,
        meta: {
          id_lote: id,
          banco: lote.banco_cod, qt_titulos: titulos.length,
          qt_processados: qtProc, qt_rejeitados: qtRej,
          lote_protheus: loteProth,
          httpStatus: r.httpStatus, codigo_erro: body.codigo_erro
        }
      });

      return res.json({
        ok: okGeral,
        status: novoStatus,
        lote_protheus: loteProth || null,
        qt_processados: qtProc,
        qt_rejeitados: qtRej,
        httpStatus: r.httpStatus,
        protheus: body  // inclui detalhes[] com chave de cada titulo + status
      });
    } catch (err) {
      console.error('boleto-lote enviar-protheus:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
