// Monta o PDF do boleto a partir do id do retorno do banco
// (tab_boleto_envio_lote_retorno.id).
//
// Nasceu dentro de resources/financeiro/financeiro.boleto-pdf.js. Foi extraido
// pra ca quando o portal do cliente passou a precisar do MESMO PDF: o portal
// nao pode chamar a intranet, entao a publicacao do espelho leva o PDF junto.
// Duas copias dessa montagem acabariam divergindo — e divergir aqui significa
// boleto impagavel.

const ProtheusBoleto = require('./protheusBoleto');
const BoletoPdf = require('./boletoPdf');
const PortadorCessao = require('./portadorCessao');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// Cedente fixo da Gnatus. Pego dos PDFs samples (docs/boleto-samples). Pode ser
// movido pra env futuramente se a Gnatus tiver multiplas filiais com boleto.
const BENEFICIARIO_GNATUS = {
  nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA - EPP',
  cnpj: '09609356000100',
  endereco: 'AV DOS MACONS, 405 - JARDIM RAMOS - BARRETOS - SP - CEP 14783-167'
};

const recusa = (status, body) => ({ ok: false, status, body });

async function gerar(app, id) {
  const { Pg, Protheus } = app.services;
  const idNum = Number(id);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    return recusa(400, { message: 'ID invalido.' });
  }

  // 1) Retorno + lote + titulo
  const rows = await Pg.connectAndQuery(`
    SELECT r.id, r.id_lote, r.prefixo, r.numero, r.parcela,
           r.cliente_cod, r.cliente_loja, r.nosso_numero, r.status_banco, r.data_ocorrencia,
           t.cliente_nome, t.valor, t.vencimento, t.tipo,
           l.banco_cod, l.banco_nome, l.banco_agencia, l.banco_conta
      FROM tab_boleto_envio_lote_retorno r
      JOIN tab_boleto_envio_lote l ON l.id = r.id_lote
      LEFT JOIN tab_boleto_envio_lote_titulo t
        ON t.id_lote = r.id_lote
       AND COALESCE(t.prefixo, '') = COALESCE(r.prefixo, '')
       AND t.numero = r.numero
       AND COALESCE(t.parcela, '') = COALESCE(r.parcela, '')
       AND t.cliente_cod = r.cliente_cod AND t.cliente_loja = r.cliente_loja
     WHERE r.id = @id`, { id: idNum });

  if (!rows.length) return recusa(404, { message: 'Boleto nao encontrado.' });
  const r = rows[0];
  if (trim(r.status_banco) !== 'REGISTRADO') {
    return recusa(409, {
      message: `Boleto em status ${trim(r.status_banco) || '—'} — PDF so esta disponivel apos REGISTRADO no banco.`
    });
  }

  // 2) SA1 do pagador (endereco + CNPJ)
  let pagador = { nome: trim(r.cliente_nome), cgc: '', endereco: '', bairro: '', municipio: '', uf: '', cep: '' };
  try {
    const sa1 = await Protheus.connectAndQuery(`
      SELECT RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_CGC) cgc,
             RTRIM(sa1.A1_END) endereco, RTRIM(sa1.A1_BAIRRO) bairro,
             RTRIM(sa1.A1_MUN) municipio, RTRIM(sa1.A1_EST) uf, RTRIM(sa1.A1_CEP) cep
        FROM SA1010 sa1 WITH (NOLOCK)
       WHERE sa1.D_E_L_E_T_ <> '*'
         AND sa1.A1_COD = @c AND sa1.A1_LOJA = @l`,
      { c: trim(r.cliente_cod), l: trim(r.cliente_loja) });
    if (sa1.length) {
      const s = sa1[0];
      pagador = {
        nome: trim(s.nome) || trim(r.cliente_nome),
        cgc: trim(s.cgc),
        endereco: trim(s.endereco),
        bairro: trim(s.bairro),
        municipio: trim(s.municipio),
        uf: trim(s.uf),
        cep: trim(s.cep)
      };
    }
  } catch (e) {
    console.warn('boletoDocumento: falha SA1 —', e.message);
  }

  // 3) SE1 — juros/multa/emissao + E1_VENCTO (vencimento ORIGINAL).
  // O banco emite o boleto com base em E1_VENCTO. Depois o titulo pode ser
  // prorrogado (E1_VENCREA muda) mas a linha digitavel do boleto fisico
  // continua com a data original — entao usamos E1_VENCTO no calculo, nao
  // r.vencimento (que pode estar com VENCREA).
  let se1 = { emissao: '', venctoOriginal: '', jurosDia: 0, multaPct: 0 };
  try {
    const r1 = await Protheus.connectAndQuery(`
      SELECT RTRIM(se1.E1_EMISSAO) emissao, RTRIM(se1.E1_VENCTO) vencto_original,
             se1.E1_VALJUR juros_dia, se1.E1_MULTA multa_pct
        FROM SE1010 se1 WITH (NOLOCK)
       WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
         AND se1.E1_PREFIXO = @p AND se1.E1_NUM = @n AND se1.E1_PARCELA = @pa
         AND se1.E1_CLIENTE = @c AND se1.E1_LOJA = @l`,
      { p: trim(r.prefixo), n: trim(r.numero), pa: trim(r.parcela),
        c: trim(r.cliente_cod), l: trim(r.cliente_loja) });
    if (r1.length) {
      se1 = {
        emissao: trim(r1[0].emissao),
        venctoOriginal: trim(r1[0].vencto_original),
        jurosDia: N(r1[0].juros_dia),
        multaPct: N(r1[0].multa_pct)
      };
    }
  } catch (e) {
    console.warn('boletoDocumento: falha SE1 —', e.message);
  }

  // Vencimento usado pra calcular linha + mostrar no PDF (precisam bater).
  const venctoCalc = se1.venctoOriginal || trim(r.vencimento);

  // Dados bancarios EFETIVOS do boleto. Em portador de CESSAO (FIDC) o lote
  // guarda a ag/conta ZERADA do Protheus (serve pro borderô); o boleto sai no
  // banco liquidante, na conta do fundo (ex.: 044 -> Bradesco 237).
  const bko = PortadorCessao.dadosBoleto({
    banco: trim(r.banco_cod), agencia: trim(r.banco_agencia), conta: trim(r.banco_conta)
  });

  // TRAVA: portador de cessão cadastrado só para borderô (sem as coordenadas do
  // fundo) nao pode gerar boleto — sairia com campo livre zerado, ou seja um
  // codigo de barras invalido. Melhor recusar com motivo do que entregar um PDF
  // impagavel, que foi o estrago do bug do Itau em 15/09.
  if (bko.boletoPendente) {
    return recusa(409, {
      codigo_erro: 'BOLETO_CESSAO_NAO_CONFIGURADO',
      message: bko.motivo || `Boleto do portador ${trim(r.banco_cod)} ainda não configurado.`
    });
  }

  // 4) Linha digitavel — calculada localmente a partir dos dados base (NN do
  //    PG, ag/conta efetivas, valor do titulo, E1_VENCTO original).
  const lin = await ProtheusBoleto.linhaDigitavel({
    banco: bko.banco,
    agencia: bko.agencia,
    conta: bko.conta,
    carteira: bko.carteira,
    nossoNumero: trim(r.nosso_numero),
    valor: N(r.valor),
    vencimento: venctoCalc
  });
  const linhaDigitavel = trim(lin.body?.linha_digitavel);
  const codigoBarras = trim(lin.body?.codigo_barras);
  if (!lin.ok || !linhaDigitavel || !codigoBarras) {
    return recusa(502, {
      message: lin.body?.mensagem || 'Nao foi possivel calcular a linha digitavel.',
      codigo_erro: lin.body?.codigo_erro || 'CALCULO'
    });
  }

  // 5) Gera o PDF. Instrucoes, beneficiario e formato dos campos vem do
  //    montador unico (o mesmo do anexo do e-mail). Em cessao com layout
  //    proprio (Grupo BFC) a ficha replica a do fundo.
  const pdf = await BoletoPdf.gerarBoletoPdf(BoletoPdf.opcoesPdfBoleto({
    bko, r, pagador, se1, venctoCalc, lin, beneficiarioGnatus: BENEFICIARIO_GNATUS
  }));

  return {
    ok: true,
    pdf,
    filename: `boleto_${trim(r.numero)}${trim(r.parcela) ? '-' + trim(r.parcela) : ''}.pdf`,
    linha_digitavel: linhaDigitavel,
    codigo_barras: codigoBarras
  };
}

module.exports = { gerar, BENEFICIARIO_GNATUS };
