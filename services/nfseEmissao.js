// services/nfseEmissao.js — orquestra a emissão de NFS-e (Padrão Nacional/DPS) de
// uma NF de serviço (SF2 série C) do Protheus:
//   nfseProtheus (lê a nota) → resolve cTribNac → nfseXml (monta DPS) →
//   nfseAssinatura (assina RSA-SHA1) → nfseBarretos (envia) → grava tab_nfse_emitida.
//
// READ-ONLY no Protheus. A ÚNICA escrita é no Postgres (tab_nfse_emitida). Trava de
// emissão dupla via "reserva" PENDENTE + índice único parcial (ver migration 83).
//
// Config (.env): NFSE_AMBIENTE (homologacao=restrita | producao), NFSE_IM,
// NFSE_CMUN, NFSE_OPSIMPNAC, NFSE_REGESPTRIB, NFSE_SERIE_DPS. CNPJ vem do cert.

const { buscarNotaServico } = require('./nfseProtheus');
const { montarDps } = require('./nfseXml');
const { assinarXml, carregarCertificado } = require('./nfseAssinatura');
const { emitirDps, ambiente } = require('./nfseBarretos');

const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const trim = (v) => String(v == null ? '' : v).trim();

// De-para produto → cTribNac (fallback enquanto o B1_CODISS não é preenchido no
// cadastro do Protheus). Fonte: planilha do fiscal (data/nfse-depara-servicos.json).
let _depara = null;
function depara() {
  if (_depara) return _depara;
  _depara = {};
  try {
    for (const r of require('../data/nfse-depara-servicos.json')) {
      const cod = trim(r.codigo), ct = soDig(r.cTribNac);
      if (cod && ct) _depara[cod] = ct;
    }
  } catch (e) { console.warn('nfseEmissao: de-para indisponível:', e.message); }
  return _depara;
}

function cnpjPrestador() {
  try {
    const s = carregarCertificado().subject || '';
    return soDig((s.split(':')[1] || s)) || soDig(process.env.NFSE_CNPJ || '09609356000100');
  } catch (e) { return soDig(process.env.NFSE_CNPJ || '09609356000100'); }
}

function config() {
  const amb = ambiente();                                   // 'homologacao' | 'producao'
  const ambienteRotulo = amb === 'producao' ? 'producao' : 'restrita';
  return {
    ambienteRotulo,
    cfg: {
      cnpjPrestador: cnpjPrestador(),
      inscricaoMunicipalPrestador: trim(process.env.NFSE_IM || '080701000506'),
      codigoMunicipioPrestador: trim(process.env.NFSE_CMUN || '3505500'),
      opSimpNac: Number(process.env.NFSE_OPSIMPNAC || 1),
      regEspTrib: Number(process.env.NFSE_REGESPTRIB || 0),
      serieDps: trim(process.env.NFSE_SERIE_DPS || '1'),
      tpAmb: amb === 'producao' ? 1 : 2
    }
  };
}

// Elege o item principal e resolve o cTribNac (6 díg, sem pontos).
// Retorna { ctribnac, produto } — ctribnac vazio = não resolvido.
function resolverCtribNac(nota) {
  const itens = nota.itens || [];
  const principal = itens.find((i) => trim(i.itemListaServico))
    || itens.slice().sort((a, b) => (b.valorTotal || 0) - (a.valorTotal || 0))[0] || {};
  const produto = trim(principal.codigo);
  const ctribnac = soDig(principal.itemListaServico) || depara()[produto] || '';  // 1) B1_CODISS  2) de-para
  return { ctribnac, produto };
}

// UPDATE de finalização da linha reservada. `f` traz só os campos a gravar.
async function finalizar(Pg, id, f) {
  const rows = await Pg.connectAndQuery(`
    UPDATE tab_nfse_emitida SET
      status        = @st,
      cliente_nome  = COALESCE(@nome, cliente_nome),
      valor         = COALESCE(@val,  valor),
      discriminacao = COALESCE(@disc, discriminacao),
      ctribnac      = COALESCE(@ct,   ctribnac),
      dps_id        = COALESCE(@dpsid, dps_id),
      dps_xml       = COALESCE(@dpsxml, dps_xml),
      nfse_chave    = COALESCE(@chave, nfse_chave),
      nfse_xml      = COALESCE(@nfsexml, nfse_xml),
      retorno       = COALESCE(@ret::jsonb, retorno),
      erros         = COALESCE(@err::jsonb, erros),
      emitido_em    = CASE WHEN @st = 'EMITIDA' THEN NOW() ELSE emitido_em END,
      atualizado_em = NOW()
    WHERE id = @id
    RETURNING id, status, nfse_chave`,
    {
      id, st: f.status,
      nome: f.cliente_nome != null ? f.cliente_nome : null,
      val: f.valor != null ? f.valor : null,
      disc: f.discriminacao != null ? f.discriminacao : null,
      ct: f.ctribnac || null,
      dpsid: f.dps_id || null, dpsxml: f.dps_xml || null,
      chave: f.nfse_chave || null, nfsexml: f.nfse_xml || null,
      ret: f.retorno ? JSON.stringify(f.retorno) : null,
      err: f.erros ? JSON.stringify(f.erros) : null
    });
  return rows[0];
}

// Emite (ou devolve a emissão já feita) da nota {serie, doc, cliente, loja}.
async function emitirNota(app, { serie = 'C', doc, cliente, loja, user }) {
  const { Pg, Protheus } = app.services;
  const { ambienteRotulo, cfg } = config();
  const k = { filial: '01', serie: trim(serie), doc: trim(doc), cliente: trim(cliente), loja: trim(loja) };
  const por = trim(user && (user.EMAIL || user.NOME)) || 'sistema';

  // 1) reserva a emissão (INSERT PENDENTE). Conflito = já EMITIDA ou em andamento.
  const ins = await Pg.connectAndQuery(`
    INSERT INTO tab_nfse_emitida (filial, serie, doc, cliente, loja, ambiente, status, emitido_por)
    VALUES (@f, @s, @d, @c, @l, @amb, 'PENDENTE', @por)
    ON CONFLICT (filial, serie, doc, cliente, loja, ambiente) WHERE status IN ('PENDENTE', 'EMITIDA')
    DO NOTHING
    RETURNING id`,
    { f: k.filial, s: k.serie, d: k.doc, c: k.cliente, l: k.loja, amb: ambienteRotulo, por });
  if (!ins.length) {
    const ex = await Pg.connectAndQuery(`
      SELECT id, status, nfse_chave, emitido_em FROM tab_nfse_emitida
       WHERE filial=@f AND serie=@s AND doc=@d AND cliente=@c AND loja=@l AND ambiente=@amb
         AND status IN ('PENDENTE','EMITIDA') ORDER BY id DESC LIMIT 1`,
      { f: k.filial, s: k.serie, d: k.doc, c: k.cliente, l: k.loja, amb: ambienteRotulo });
    const e = ex[0] || {};
    return { ok: e.status === 'EMITIDA', jaEmitida: e.status === 'EMITIDA', emAndamento: e.status === 'PENDENTE', id: e.id, chave: e.nfse_chave || null };
  }
  const id = ins[0].id;

  try {
    const nota = await buscarNotaServico(Protheus, k);
    if (!nota) {
      await finalizar(Pg, id, { status: 'ERRO', erros: [{ Codigo: 'NAO_ENCONTRADA', Descricao: `Nota ${serie}/${doc} (cliente ${cliente}/${loja}) não encontrada na SF2.` }] });
      return { ok: false, erro: 'NAO_ENCONTRADA', id };
    }

    const { ctribnac, produto } = resolverCtribNac(nota);
    const dados = {
      cliente_nome: trim(nota.tomador && nota.tomador.razaoSocial).slice(0, 200),
      valor: nota.valorServicos, discriminacao: trim(nota.discriminacao).slice(0, 4000), ctribnac
    };
    if (!ctribnac) {
      await finalizar(Pg, id, { ...dados, status: 'ERRO', erros: [{ Codigo: 'SEM_CTRIBNAC', Descricao: `Serviço sem código de tributação nacional (produto ${produto}). Preencha o B1_CODISS ou o de-para.` }] });
      return { ok: false, erro: 'SEM_CTRIBNAC', produto, id };
    }

    cfg.cTribNacPadrao = ctribnac;
    const { xml, id: dpsId } = montarDps(nota, cfg);
    const signed = assinarXml(xml);                          // RSA-SHA1 (default, exigido por Barretos v1.00)
    const r = await emitirDps(signed);
    const status = r.ok ? 'EMITIDA' : (r.erros && r.erros.length ? 'REJEITADA' : 'ERRO');
    await finalizar(Pg, id, {
      ...dados, status, dps_id: dpsId, dps_xml: signed,
      nfse_chave: r.chaveAcesso, nfse_xml: r.nfseXml,
      retorno: { httpStatus: r.httpStatus, ok: r.ok, alertas: r.alertas || [] }, erros: r.erros || []
    });
    return { ok: r.ok, status, id, chave: r.chaveAcesso || null, httpStatus: r.httpStatus, erros: r.erros || [], ctribnac };
  } catch (e) {
    await finalizar(Pg, id, { status: 'ERRO', erros: [{ Codigo: 'EXCECAO', Descricao: e.message }] });
    return { ok: false, erro: 'EXCECAO', mensagem: e.message, id };
  }
}

module.exports = { emitirNota, resolverCtribNac, config, depara, cnpjPrestador };
