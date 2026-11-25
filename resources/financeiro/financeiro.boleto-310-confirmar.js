// POST /financeiro/boleto-310-confirmar
// Body: { bordero, simular?, confirmado_delmonte? }
//
// Banco 310 (Vortx DTVM / Grafeno, cobranca em garantia da DelMonte): coloca os
// titulos de um borderô no fluxo de boletos da intranet (PDF, disparo, portal).
//
// Por que existe: o 310 NAO tem arquivo de retorno (o layout da Vortx so tem
// remessa), entao o E1_OCORREN nunca recebe '02' e nem o adotar-SE1 nem o
// "Registrar pelo .RET" enxergam esses titulos. A Gnatus gera o nosso numero
// (E1_NUMBCO, 11 digitos) e o boleto sai logo depois da remessa — mas so pode ir
// ao cliente DEPOIS que a DelMonte confirmar o recebimento do arquivo. Essa
// confirmacao e' humana; este endpoint e' onde ela fica registrada.
//
// O que faz (via BoletoAdotar.criarLotesRetroativos, o mesmo do adotar-SE1):
// cria um lote RETORNADO para a carteira 310 com os titulos do borderô ja como
// REGISTRADO e o nosso numero da SE1. A sincronizacao depois preserva o
// REGISTRADO (E1_OCORREN vazio nao rebaixa) e marca LIQUIDADO pela E1_BAIXA.
//
// Travas:
//   - borderô de TESTE (001523 + BANCO_310_BORDEROS_TESTE) -> 409, nunca grava;
//   - gravar exige simular:false E confirmado_delmonte:true;
//   - titulo baixado, sem nosso numero de 11 digitos, de outra conta, ou ainda
//     REGISTRADO num lote de outro banco fica de fora (ver planejarConfirmacao);
//   - titulo ja num lote 310 nao duplica.
//
// simular:true (default) -> so mostra o que seria feito. Permissao 8005.
// Nada e' gravado no Protheus — so na intranet.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const BoletoAdotar = require('../../services/boletoAdotar');
const BoletoVortx = require('../../services/boletoVortx');
const LinhaDigitavel = require('../../services/linhaDigitavel');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const arred2 = (v) => Math.round(N(v) * 100) / 100;

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-310-confirmar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const borderoIn = trim(req.body?.bordero).replace(/\D/g, '');
    const simular = req.body?.simular !== false;

    if (!borderoIn || borderoIn.length > 6 || /\D/.test(trim(req.body?.bordero))) {
      return res.status(400).json({ codigo_erro: 'BORDERO_INVALIDO', message: 'Informe o número do borderô (até 6 dígitos).' });
    }
    const bordero = borderoIn.padStart(6, '0');

    try {
      // 1) SE1 do borderô no banco 310
      const titulos = await Protheus.connectAndQuery(`
        SELECT RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela,
               RTRIM(E1_TIPO) tipo, RTRIM(E1_CLIENTE) cliente_cod, RTRIM(E1_LOJA) cliente_loja,
               RTRIM(E1_NOMCLI) cliente_nome, RTRIM(E1_NUMBCO) numbco, RTRIM(E1_PORTADO) portador,
               RTRIM(E1_AGEDEP) agencia, RTRIM(E1_CONTA) conta, RTRIM(E1_NUMBOR) bordero,
               E1_VALOR valor, E1_SALDO saldo, RTRIM(E1_STATUS) status,
               RTRIM(E1_VENCREA) vencimento, RTRIM(E1_VENCTO) vencto
          FROM SE1010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*' AND E1_FILIAL = '01'
           AND RTRIM(E1_PORTADO) = @banco AND E1_NUMBOR = @bord
           AND RTRIM(E1_TIPO) NOT IN ('RA','NCC')
         ORDER BY E1_NUM, E1_PARCELA`, { banco: BoletoVortx.BANCO, bord: bordero });

      if (!titulos.length) {
        return res.status(404).json({ codigo_erro: 'BORDERO_SEM_TITULOS',
          message: `Nenhum título do banco 310 no borderô ${bordero} (SE1, filial 01).` });
      }

      // 2) Em que lotes da intranet esses titulos ja estao (lote cancelado nao conta)
      const nums = [...new Set(titulos.map((t) => trim(t.numero)))];
      const p = {};
      nums.forEach((n, i) => { p[`n${String(i).padStart(4, '0')}`] = n; });
      const linhas = await Pg.connectAndQuery(`
        SELECT t.prefixo, t.numero, t.parcela, t.cliente_cod, t.cliente_loja,
               t.id_lote, l.banco_cod, r.status_banco
          FROM tab_boleto_envio_lote_titulo t
          JOIN tab_boleto_envio_lote l ON l.id = t.id_lote
          LEFT JOIN tab_boleto_envio_lote_retorno r
            ON r.id_lote = t.id_lote
           AND COALESCE(r.prefixo, '') = COALESCE(t.prefixo, '') AND r.numero = t.numero
           AND COALESCE(r.parcela, '') = COALESCE(t.parcela, '')
           AND r.cliente_cod = t.cliente_cod AND r.cliente_loja = t.cliente_loja
         WHERE l.status <> 'CANCELADO'
           AND t.numero IN (${Object.keys(p).map((k) => `@${k}`).join(',')})`, p);
      const emLotes = {};
      for (const l of linhas) {
        const k = BoletoVortx.chaveDe(l);
        (emLotes[k] = emLotes[k] || []).push({ id_lote: l.id_lote, banco_cod: trim(l.banco_cod), status_banco: trim(l.status_banco) });
      }

      const plano = BoletoVortx.planejarConfirmacao({ bordero, titulos, emLotes });
      const resumo = {
        bordero,
        bordero_teste: plano.bordero_teste,
        titulos: titulos.length,
        valor_bordero: arred2(titulos.reduce((s, t) => s + N(t.valor), 0)),
        a_confirmar: plano.a_confirmar.length,
        valor_a_confirmar: arred2(plano.a_confirmar.reduce((s, t) => s + N(t.valor), 0)),
        a_confirmar_lista: plano.a_confirmar.map((t) => ({
          titulo: BoletoVortx.tituloDe(t), cliente: `${trim(t.cliente_cod)}/${trim(t.cliente_loja)} ${trim(t.cliente_nome)}`.trim(),
          valor: N(t.valor), vencimento: trim(t.vencto) || trim(t.vencimento),
          nosso_numero: LinhaDigitavel.formatarNossoNumero(BoletoVortx.BANCO, t.numbco)
        })),
        ja_confirmados: plano.ja_confirmados.length,
        ja_confirmados_lista: plano.ja_confirmados,
        ignorados: plano.ignorados.length,
        ignorados_lista: plano.ignorados
      };

      if (plano.bordero_teste) {
        if (simular) {
          return res.json({ ok: true, simular: true, ...resumo,
            mensagem: `Borderô ${bordero} é de TESTE: os títulos não estão registrados na Vortx e não podem ir ao cliente.` });
        }
        return res.status(409).json({ codigo_erro: 'BORDERO_TESTE', ...resumo,
          message: `Borderô ${bordero} é de TESTE (não registrado na Vortx). Nada foi gravado.` });
      }

      if (simular) {
        return res.json({ ok: true, simular: true, ...resumo,
          mensagem: `${resumo.a_confirmar} título(s) do borderô ${bordero} ficariam disparáveis`
            + (resumo.ja_confirmados ? `; ${resumo.ja_confirmados} já confirmado(s)` : '')
            + (resumo.ignorados ? `; ${resumo.ignorados} ficam de fora` : '') + '.' });
      }

      if (req.body?.confirmado_delmonte !== true) {
        return res.status(400).json({ codigo_erro: 'CONFIRMACAO_OBRIGATORIA', ...resumo,
          message: 'Só confirme depois que a DelMonte confirmar o recebimento do arquivo deste borderô (confirmado_delmonte).' });
      }

      if (!plano.a_confirmar.length) {
        return res.json({ ok: true, simular: false, confirmados: 0, lotes: [], ...resumo, mensagem: 'Nada novo a confirmar.' });
      }

      const quem = trim(user?.NOME) || 'usuário';
      const adocao = await BoletoAdotar.criarLotesRetroativos({
        Pg, Protheus, user, titulos: plano.a_confirmar,
        rotulo: `borderô ${bordero} confirmado`,
        ocorrenciaDesc: 'Registro confirmado pela DelMonte (banco 310 sem retorno)',
        observacao: `Lote do banco 310 (Vortx/DelMonte) criado em ${new Date().toISOString()} por ${quem}, `
          + `que confirmou o recebimento do arquivo do borderô ${bordero} pela DelMonte. `
          + 'O 310 não tem retorno: o nosso número é o E1_NUMBCO gerado pelo Protheus.'
      });
      const lotes = (adocao.lotes || []).map((l) => l.id);

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'CONFIRMAR_REGISTRO_310', severidade: 'CRITICO', req,
        entidade: 'lote', entidadeId: lotes.join(','),
        descricao: `Confirmou o registro de ${plano.a_confirmar.length} título(s) do borderô ${bordero} (banco 310 Vortx/DelMonte)`
          + ` — R$ ${resumo.valor_a_confirmar.toFixed(2)}; a DelMonte confirmou o recebimento do arquivo. Lotes: ${lotes.join(',')}`,
        meta: { ...resumo, lotes }
      });

      return res.json({ ok: true, simular: false, confirmados: adocao.adotados || 0, lotes, ...resumo,
        mensagem: `${adocao.adotados || 0} título(s) do borderô ${bordero} confirmados. Ficam disparáveis em "Disparar boletos".` });
    } catch (err) {
      console.error('boleto-310-confirmar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
