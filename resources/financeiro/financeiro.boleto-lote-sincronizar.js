// POST /financeiro/boleto-lote/:id/sincronizar
//
// Consulta SE1 no Protheus pra cada titulo do lote, le E1_OCORREN/E1_NUMBOR/
// E1_NUMBCO/E1_BAIXA e atualiza tab_boleto_envio_lote_retorno com o status
// banco a banco. Atualiza tambem contadores do lote.
//
// Pre-condicao: lote em status >= 'ENVIADO_PROTHEUS'.
//
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// Mapeamento de codigo de ocorrencia (E1_OCORREN) -> status interno
// Codigos sao padrao TOTVS, mas podem variar — ajustar conforme aparecem
// "DESCONHECIDO" no log.
const MAP_OCORRENCIA = {
  '02': { status: 'REGISTRADO', desc: 'Entrada confirmada — boleto registrado' },
  '03': { status: 'REJEITADO',  desc: 'Entrada rejeitada' },
  '06': { status: 'LIQUIDADO',  desc: 'Liquidação' },
  '09': { status: 'BAIXADO',    desc: 'Baixa manual' },
  '10': { status: 'BAIXADO',    desc: 'Baixa por solicitação' },
  '11': { status: 'REGISTRADO', desc: 'Em ser (carteira do banco)' },
  '12': { status: 'REJEITADO',  desc: 'Abatimento concedido (instrução)' },
  '13': { status: 'REJEITADO',  desc: 'Abatimento cancelado' },
  '14': { status: 'REGISTRADO', desc: 'Vencimento alterado' },
  '15': { status: 'LIQUIDADO',  desc: 'Liquidação em cartório' },
  '17': { status: 'LIQUIDADO',  desc: 'Liquidação após baixa' },
  '20': { status: 'REGISTRADO', desc: 'Confirmação de recebimento' },
  // Itau: ocorrencia 21 confirmada pelo financeiro como entrada/registro do boleto
  '21': { status: 'REGISTRADO', desc: 'Entrada confirmada (ocorrência 21)' },
  '23': { status: 'REGISTRADO', desc: 'Remessa a cartório' },
  '24': { status: 'REGISTRADO', desc: 'Retirada de cartório' },
  '32': { status: 'REJEITADO',  desc: 'Instrução rejeitada' },
  '33': { status: 'REJEITADO',  desc: 'Confirmação pedido alteração' },
  '34': { status: 'REJEITADO',  desc: 'Retirado pelo beneficiário' }
};

// Detecta status pelo conjunto E1_OCORREN + E1_BAIXA (liquidado tem prioridade)
function classificarStatus(ocorren, dataBaixa, valorLiq) {
  const oc = trim(ocorren);
  const baixa = trim(dataBaixa);
  // Se tem baixa preenchida, considera liquidado independente de ocorren
  if (baixa && N(valorLiq) > 0) {
    return { status: 'LIQUIDADO', cod: oc || 'BAIXA', desc: 'Liquidação confirmada' };
  }
  if (!oc) {
    return { status: 'PENDENTE', cod: '', desc: 'Aguardando processamento do retorno no Protheus' };
  }
  const m = MAP_OCORRENCIA[oc];
  if (m) return { status: m.status, cod: oc, desc: m.desc };
  return { status: 'DESCONHECIDO', cod: oc, desc: `Ocorrência ${oc} (não mapeada)` };
}

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-lote/:id/sincronizar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido.' });
    }

    try {
      // 1) Carrega lote + valida status
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
        return res.status(403).json({ message: 'Sem permissao pra sincronizar este lote.' });
      }

      if (!['ENVIADO_PROTHEUS', 'RETORNADO', 'DISPARADO'].includes(lote.status)) {
        return res.status(409).json({
          message: `Lote em status "${lote.status}" — sincroniza so depois de "ENVIADO_PROTHEUS".`
        });
      }

      // 2) Carrega titulos do lote
      const titulos = await Pg.connectAndQuery(
        `SELECT prefixo, numero, parcela, cliente_cod, cliente_loja
           FROM tab_boleto_envio_lote_titulo WHERE id_lote = @id`, { id }
      );
      if (!titulos.length) return res.status(400).json({ message: 'Lote sem titulos.' });

      // 3) Consulta SE1 em batches de 100 OR-clauses (limite ~2100 params do MSSQL)
      const BATCH = 100;
      const seRows = [];
      for (let i = 0; i < titulos.length; i += BATCH) {
        const slice = titulos.slice(i, i + BATCH);
        const condicoes = slice.map((_, k) =>
          `(se1.E1_PREFIXO = @p${k} AND se1.E1_NUM = @n${k} AND se1.E1_PARCELA = @pa${k}
            AND se1.E1_CLIENTE = @cl${k} AND se1.E1_LOJA = @lo${k})`
        ).join(' OR ');
        const params = {};
        slice.forEach((t, k) => {
          params[`p${k}`]  = trim(t.prefixo);
          params[`n${k}`]  = trim(t.numero);
          params[`pa${k}`] = trim(t.parcela);
          params[`cl${k}`] = trim(t.cliente_cod);
          params[`lo${k}`] = trim(t.cliente_loja);
        });

        const sql = `
          SELECT RTRIM(se1.E1_PREFIXO) prefixo,
                 RTRIM(se1.E1_NUM)     numero,
                 RTRIM(se1.E1_PARCELA) parcela,
                 RTRIM(se1.E1_CLIENTE) cliente_cod,
                 RTRIM(se1.E1_LOJA)    cliente_loja,
                 RTRIM(se1.E1_OCORREN) ocorren,
                 RTRIM(se1.E1_NUMBOR)  bordero,
                 RTRIM(se1.E1_NUMBCO)  nosso_numero,
                 RTRIM(se1.E1_BAIXA)   data_baixa,
                 se1.E1_VALLIQ         valor_liquidado
            FROM SE1010 se1 WITH (NOLOCK)
           WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
             AND (${condicoes})`;
        const r = await Protheus.connectAndQuery(sql, params);
        seRows.push(...r);
      }

      // 4) Indexa por chave pra UPSERT
      const seByKey = new Map();
      seRows.forEach(r => {
        const key = [trim(r.prefixo), trim(r.numero), trim(r.parcela), trim(r.cliente_cod), trim(r.cliente_loja)].join('|');
        seByKey.set(key, r);
      });

      const stats = { PENDENTE: 0, REGISTRADO: 0, LIQUIDADO: 0, BAIXADO: 0, REJEITADO: 0, DESCONHECIDO: 0, NAO_ENCONTRADO: 0 };
      for (const t of titulos) {
        const key = [trim(t.prefixo), trim(t.numero), trim(t.parcela), trim(t.cliente_cod), trim(t.cliente_loja)].join('|');
        const se = seByKey.get(key);
        let cls;
        if (!se) {
          cls = { status: 'NAO_ENCONTRADO', cod: '', desc: 'Título não encontrado na SE1 (deletado?)' };
        } else {
          cls = classificarStatus(se.ocorren, se.data_baixa, se.valor_liquidado);
        }
        stats[cls.status] = (stats[cls.status] || 0) + 1;

        await Pg.connectAndQuery(`
          INSERT INTO tab_boleto_envio_lote_retorno (
            id_lote, prefixo, numero, parcela, cliente_cod, cliente_loja,
            status_banco, ocorrencia_cod, ocorrencia_desc,
            nosso_numero, bordero_protheus,
            valor_liquidado, data_liquidacao, sincronizado_em
          ) VALUES (
            @id, @prefixo, @numero, @parcela, @cliente_cod, @cliente_loja,
            @status, @oc_cod, @oc_desc,
            @nn, @bord,
            @vlq, @dlq, NOW()
          )
          ON CONFLICT (id_lote, prefixo, numero, parcela, cliente_cod, cliente_loja)
          DO UPDATE SET
            status_banco     = EXCLUDED.status_banco,
            ocorrencia_cod   = EXCLUDED.ocorrencia_cod,
            ocorrencia_desc  = EXCLUDED.ocorrencia_desc,
            nosso_numero     = EXCLUDED.nosso_numero,
            bordero_protheus = EXCLUDED.bordero_protheus,
            valor_liquidado  = EXCLUDED.valor_liquidado,
            data_liquidacao  = EXCLUDED.data_liquidacao,
            sincronizado_em  = NOW()`,
          {
            id,
            prefixo: trim(t.prefixo), numero: trim(t.numero), parcela: trim(t.parcela),
            cliente_cod: trim(t.cliente_cod), cliente_loja: trim(t.cliente_loja),
            status: cls.status, oc_cod: cls.cod, oc_desc: cls.desc,
            nn:   se ? trim(se.nosso_numero) : null,
            bord: se ? trim(se.bordero) : null,
            vlq:  se ? N(se.valor_liquidado) : 0,
            dlq:  se ? trim(se.data_baixa) : null
          }
        );
      }

      // 5) Atualiza contadores do lote + status global
      // Se TODOS liquidados/baixados -> RETORNADO. Senao mantem ENVIADO_PROTHEUS (parcial)
      const totalProc = titulos.length - stats.PENDENTE - stats.NAO_ENCONTRADO;
      const novoStatus = totalProc === titulos.length
        ? 'RETORNADO'
        : lote.status === 'ENVIADO_PROTHEUS' ? 'ENVIADO_PROTHEUS' : lote.status;

      await Pg.connectAndQuery(`
        UPDATE tab_boleto_envio_lote SET
          sincronizado_em      = NOW(),
          qt_registrados       = @reg,
          qt_liquidados        = @liq,
          qt_rejeitados_banco  = @rej,
          qt_pendentes_banco   = @pen,
          status               = @st,
          atualizado_em        = NOW()
         WHERE id = @id`,
        {
          id,
          reg: stats.REGISTRADO,
          liq: stats.LIQUIDADO + stats.BAIXADO,
          rej: stats.REJEITADO,
          pen: stats.PENDENTE + stats.NAO_ENCONTRADO + stats.DESCONHECIDO,
          st: novoStatus
        }
      );

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'SINCRONIZAR_BANCO', severidade: 'INFO',
        req, entidade: 'boleto_lote', entidadeId: String(id),
        descricao: `Sincronizou status do lote #${id}: ${stats.REGISTRADO} reg, ${stats.LIQUIDADO} liq, ${stats.REJEITADO} rej, ${stats.PENDENTE} pend`,
        meta: { id_lote: id, ...stats, novo_status: novoStatus }
      });

      return res.json({
        ok: true,
        id_lote: id,
        novo_status: novoStatus,
        stats
      });
    } catch (err) {
      console.error('boleto-lote sincronizar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
