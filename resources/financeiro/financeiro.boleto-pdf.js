// GET /financeiro/boleto-pdf/:id
//
// Gera o PDF do boleto no layout Febraban 102 (recibo do pagador + ficha de
// compensacao + codigo de barras Interleaved 2 of 5). Mesmos dados que o
// boleto-disparar usa pra montar o e-mail, mas renderizados como PDF.
//
//   :id = tab_boleto_envio_lote_retorno.id (do titulo REGISTRADO no banco)
//
// Resposta: application/pdf (inline; usuario salva ou imprime no browser).
// Em caso de erro, devolve JSON 4xx/5xx.
//
// Permissao 8005 (mesma de Envio de Boleto).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const ProtheusBoleto = require('../../services/protheusBoleto');
const BoletoPdf = require('../../services/boletoPdf');
const PortadorCessao = require('../../services/portadorCessao');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// Cedente fixo da Gnatus. Pego dos PDFs samples (docs/boleto-samples). Pode ser
// movido pra env futuramente se a Gnatus tiver multiplas filiais com boleto.
const BENEFICIARIO_GNATUS = {
  nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA - EPP',
  cnpj: '09609356000100',
  endereco: 'AV DOS MACONS, 405 - JARDIM RAMOS - BARRETOS - SP - CEP 14783-167'
};

// Espécie por banco. Santander usa 'DM' no Protheus, Itau usa 'DMI'. Default DM.
const ESPECIE_POR_BANCO = { '341': 'DMI', '033': 'DM' };

// Carteira "legivel" — o Diego retorna o codigo numerico, mas o boleto mostra
// nome curto. Pra Santander e' "PENH. ELETR" (penhor eletronico, carteira 101).
const CARTEIRA_LABEL = { '101': 'PENH. ELETR', '109': '109' };

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-pdf/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'ID invalido.' });
    }

    try {
      // 1) Retorno + lote + titulo
      const rows = await Pg.connectAndQuery(`
        SELECT r.id, r.id_lote, r.prefixo, r.numero, r.parcela,
               r.cliente_cod, r.cliente_loja, r.nosso_numero, r.status_banco,
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
         WHERE r.id = @id`, { id });

      if (!rows.length) return res.status(404).json({ message: 'Boleto nao encontrado.' });
      const r = rows[0];
      if (trim(r.status_banco) !== 'REGISTRADO') {
        return res.status(409).json({ message: `Boleto em status ${trim(r.status_banco) || '—'} — PDF so esta disponivel apos REGISTRADO no banco.` });
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
        console.warn('boleto-pdf: falha SA1 —', e.message);
      }

      // 3) SE1 — juros/multa/emissao + E1_VENCTO (vencimento ORIGINAL).
      // O banco emite o boleto com base em E1_VENCTO. Depois o titulo pode
      // ser prorrogado (E1_VENCREA muda) mas a linha digitavel do boleto
      // fisico continua com a data original — entao usamos E1_VENCTO no
      // calculo, nao r.vencimento (que pode estar com VENCREA).
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
        console.warn('boleto-pdf: falha SE1 —', e.message);
      }

      // Vencimento usado pra calcular linha + mostrar no PDF (precisam bater).
      const venctoCalc = se1.venctoOriginal || trim(r.vencimento);

      // Dados bancarios EFETIVOS do boleto. Em portador de CESSAO (FIDC) o lote
      // guarda a ag/conta ZERADA do Protheus (serve pro borderô); o boleto sai
      // no banco liquidante, na conta do fundo (ex.: 044 -> Bradesco 237).
      const bko = PortadorCessao.dadosBoleto({
        banco: trim(r.banco_cod), agencia: trim(r.banco_agencia), conta: trim(r.banco_conta)
      });

      // 4) Linha digitavel — calculada localmente a partir dos dados base
      //    (NN do PG, ag/conta efetivas, valor do titulo, E1_VENCTO original).
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
        return res.status(502).json({
          message: lin.body?.mensagem || 'Nao foi possivel calcular a linha digitavel.',
          codigo_erro: lin.body?.codigo_erro || 'CALCULO'
        });
      }

      // 5) Monta instrucoes (juros R$/dia + multa apos venc). Em cessao, as
      //    instrucoes do FUNDO vem primeiro (obrigatorias no boleto cedido).
      const instrucoes = [
        ...(bko.instrucoes || []),
        ...BoletoPdf.montarInstrucoes({
          jurosDia: se1.jurosDia,
          multaPct: se1.multaPct,
          valor: r.valor,
          vencimento: venctoCalc
        })
      ];

      // 6) Gera o PDF
      const pdfBuffer = await BoletoPdf.gerarBoletoPdf({
        banco: bko.banco,
        beneficiario: bko.cessao && bko.beneficiarioFinal
          ? { ...bko.beneficiarioFinal, endereco: BENEFICIARIO_GNATUS.endereco }   // cedido: quem cobra e' o FUNDO
          : BENEFICIARIO_GNATUS,
        beneficiarioFinal: bko.cessao ? BENEFICIARIO_GNATUS : null,                // sacador/avalista = Gnatus
        pagador,
        valor: N(r.valor),
        vencimento: venctoCalc,
        numeroDocumento: trim(r.numero),
        dataDocumento: se1.emissao || venctoCalc,
        nossoNumero: trim(r.nosso_numero) || trim(lin.body?.nosso_numero),
        agencia: bko.agencia,
        conta: bko.conta,
        carteira: CARTEIRA_LABEL[trim(lin.body?.carteira)] || trim(lin.body?.carteira) || (bko.banco === '033' ? 'PENH. ELETR' : '109'),
        especieDoc: bko.especie || ESPECIE_POR_BANCO[bko.banco] || 'DM',
        linhaDigitavel,
        codigoBarras,
        instrucoes
      });

      const filename = `boleto_${trim(r.numero)}${trim(r.parcela) ? '-' + trim(r.parcela) : ''}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(pdfBuffer.length));
      return res.end(pdfBuffer);
    } catch (err) {
      console.error('boleto-pdf:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
