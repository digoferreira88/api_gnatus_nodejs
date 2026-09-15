// Sincroniza o status bancario dos titulos de um lote de boleto lendo a
// verdade da SE1 (E1_OCORREN / E1_BAIXA / E1_VALLIQ).
//
// Extraido de resources/financeiro/financeiro.boleto-lote-sincronizar.js para
// ser reaproveitado depois da BAIXA pelo .RET (boleto-importar-retorno com
// baixar:true): em vez de confiar no detalhes[] do Protheus para marcar o
// titulo como LIQUIDADO, re-sincronizamos os lotes afetados a partir da SE1.
// Comportamento identico ao handler original, inclusive a guarda de
// nao-rebaixamento de status.

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// Lote so e' sincronizavel depois de ir ao Protheus.
const STATUS_SINCRONIZAVEIS = ['ENVIADO_PROTHEUS', 'RETORNADO', 'DISPARADO'];

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

/**
 * Sincroniza um lote com a SE1. Nao valida permissao nem status — quem chama
 * decide (o handler HTTP valida dono/admin e STATUS_SINCRONIZAVEIS).
 * @returns {Promise<{encontrado:boolean, semTitulos?:boolean, novoStatus?:string, stats?:object, qtTitulos?:number}>}
 */
async function sincronizarLote({ Pg, Protheus, id }) {
  const cab = await Pg.connectAndQuery(
    `SELECT id, status FROM tab_boleto_envio_lote WHERE id = @id`, { id }
  );
  if (!cab.length) return { encontrado: false };
  const lote = cab[0];

  const titulos = await Pg.connectAndQuery(
    `SELECT prefixo, numero, parcela, cliente_cod, cliente_loja
       FROM tab_boleto_envio_lote_titulo WHERE id_lote = @id`, { id }
  );
  if (!titulos.length) return { encontrado: true, semTitulos: true };

  // Consulta SE1 em batches de 100 OR-clauses (limite ~2100 params do MSSQL)
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

  // Indexa por chave pra UPSERT
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
        -- NAO rebaixa: se a SE1 vem sem info (PENDENTE/NAO_ENCONTRADO) mas a
        -- linha ja esta REGISTRADO/LIQUIDADO/BAIXADO (ex.: registrado pelo
        -- .RET via adotar-retorno — Santander, cujo SE1 nunca recebe o
        -- E1_OCORREN), preserva o status e a ocorrencia atuais.
        status_banco = CASE
          WHEN EXCLUDED.status_banco IN ('PENDENTE','NAO_ENCONTRADO','DESCONHECIDO')
               AND tab_boleto_envio_lote_retorno.status_banco IN ('REGISTRADO','LIQUIDADO','BAIXADO')
            THEN tab_boleto_envio_lote_retorno.status_banco
          ELSE EXCLUDED.status_banco END,
        ocorrencia_cod = CASE
          WHEN EXCLUDED.status_banco IN ('PENDENTE','NAO_ENCONTRADO','DESCONHECIDO')
               AND tab_boleto_envio_lote_retorno.status_banco IN ('REGISTRADO','LIQUIDADO','BAIXADO')
            THEN tab_boleto_envio_lote_retorno.ocorrencia_cod
          ELSE EXCLUDED.ocorrencia_cod END,
        ocorrencia_desc = CASE
          WHEN EXCLUDED.status_banco IN ('PENDENTE','NAO_ENCONTRADO','DESCONHECIDO')
               AND tab_boleto_envio_lote_retorno.status_banco IN ('REGISTRADO','LIQUIDADO','BAIXADO')
            THEN tab_boleto_envio_lote_retorno.ocorrencia_desc
          ELSE EXCLUDED.ocorrencia_desc END,
        -- nunca apaga um nosso numero / borderô ja preenchido
        nosso_numero     = COALESCE(NULLIF(EXCLUDED.nosso_numero, ''), tab_boleto_envio_lote_retorno.nosso_numero),
        bordero_protheus = COALESCE(NULLIF(EXCLUDED.bordero_protheus, ''), tab_boleto_envio_lote_retorno.bordero_protheus),
        valor_liquidado  = CASE WHEN COALESCE(EXCLUDED.valor_liquidado,0) > 0 THEN EXCLUDED.valor_liquidado ELSE tab_boleto_envio_lote_retorno.valor_liquidado END,
        data_liquidacao  = COALESCE(NULLIF(EXCLUDED.data_liquidacao::text, ''), tab_boleto_envio_lote_retorno.data_liquidacao),
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

  // Recalcula stats pelo status EFETIVO gravado (pós-guarda de
  // nao-rebaixamento), nao pelo que a SE1 sugeriu. Sem isso, titulos
  // registrados pelo .RET (preservados) seriam contados como PENDENTE.
  const efetivo = await Pg.connectAndQuery(
    `SELECT status_banco, COUNT(*) qt FROM tab_boleto_envio_lote_retorno WHERE id_lote = @id GROUP BY status_banco`, { id });
  Object.keys(stats).forEach(k => { stats[k] = 0; });
  efetivo.forEach(r => { stats[trim(r.status_banco)] = N(r.qt); });

  // Atualiza contadores do lote + status global
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

  return { encontrado: true, semTitulos: false, novoStatus, stats, qtTitulos: titulos.length };
}

/**
 * Ids dos lotes sincronizaveis que contem algum dos titulos informados.
 * O numero e' comparado sem zeros a esquerda (o Protheus pode devolver
 * '089553' ou '000089553'); prefixo so filtra quando vier preenchido.
 * @param {{prefixo?:string, numero:string, parcela?:string}[]} chaves
 * @returns {Promise<number[]>}
 */
async function lotesDosTitulos({ Pg, chaves }) {
  const ids = new Set();
  const lista = (chaves || []).filter(c => trim(c && c.numero));
  const BATCH = 100;
  for (let i = 0; i < lista.length; i += BATCH) {
    const slice = lista.slice(i, i + BATCH);
    const params = {};
    // Nomes de parametro com largura fixa (num_0000…): nenhum nome e' prefixo de
    // outro, entao a traducao @nome -> $N do Pg nao tem como trocar o errado.
    const ors = slice.map((c, k) => {
      const s = String(k).padStart(4, '0');
      params[`num_${s}`] = trim(c.numero).replace(/^0+/, '');
      params[`par_${s}`] = trim(c.parcela);
      let cond = `(LTRIM(COALESCE(TRIM(t.numero),''),'0') = @num_${s}`
        + ` AND COALESCE(TRIM(t.parcela),'') = @par_${s}`;
      if (trim(c.prefixo)) {
        params[`pre_${s}`] = trim(c.prefixo);
        cond += ` AND COALESCE(TRIM(t.prefixo),'') = @pre_${s}`;
      }
      return cond + ')';
    }).join(' OR ');

    const rows = await Pg.connectAndQuery(`
      SELECT DISTINCT t.id_lote
        FROM tab_boleto_envio_lote_titulo t
        JOIN tab_boleto_envio_lote l ON l.id = t.id_lote
       WHERE l.status IN ('ENVIADO_PROTHEUS','RETORNADO','DISPARADO')
         AND (${ors})`, params);
    rows.forEach(r => ids.add(Number(r.id_lote)));
  }
  return [...ids];
}

module.exports = { STATUS_SINCRONIZAVEIS, MAP_OCORRENCIA, classificarStatus, sincronizarLote, lotesDosTitulos };
