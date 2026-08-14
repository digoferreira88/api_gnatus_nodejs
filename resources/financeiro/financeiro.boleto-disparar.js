// POST /financeiro/boleto-disparar — dispara boleto(s) ao cliente pela LINHA
// DIGITAVEL (e-mail por enquanto; WhatsApp depende de template aprovado).
//
// Body: { ids: [<id da tab_boleto_envio_lote_retorno>, ...], canais?: ['EMAIL'] }
//
// Para cada id:
//   1) carrega o retorno + lote (banco) + titulo (valor/venc/nome);
//   2) exige status_banco='REGISTRADO';
//   3) busca o contato (e-mail) na SA1 do Protheus;
//   4) busca a LINHA DIGITAVEL via REST Diego (services/protheusBoleto);
//   5) envia por e-mail (HTML com a linha) — WhatsApp fica "pendente_template";
//   6) marca disparado_em=NOW() / canais_disparo e audita.
//
// MVP = e-mail. A linha digitavel NAO fica gravada — buscamos na hora do envio.
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const ProtheusBoleto = require('../../services/protheusBoleto');
const BoletoPdf = require('../../services/boletoPdf');
const PortadorCessao = require('../../services/portadorCessao');
const Email = require('../../services/emailService');
const Suri = require('../../services/suri');

// Cedente fixo (espelho do endpoint /boleto-pdf — manter sincronizado)
const BENEFICIARIO_GNATUS = {
  nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA - EPP',
  cnpj: '09609356000100',
  endereco: 'AV DOS MACONS, 405 - JARDIM RAMOS - BARRETOS - SP - CEP 14783-167'
};
const ESPECIE_POR_BANCO = { '341': 'DMI', '033': 'DM' };
const CARTEIRA_LABEL = { '101': 'PENH. ELETR', '109': '109' };

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// Nome curto do banco pro template do e-mail/WhatsApp do cliente. Usamos isso
// em vez do `banco_nome` cheio do lote (ex: "Santander · ag 0820 · cc 130002086
// (adotado SE1)") — cliente não tem contexto pra entender ag/cc/internals.
const BANCO_NOMES_CURTOS = {
  '341': 'Itaú', '033': 'Santander', '237': 'Bradesco',
  '001': 'Banco do Brasil', '104': 'Caixa', '748': 'Sicredi', '756': 'Sicoob'
};
const nomeBancoCurto = (cod, fallbackNome) =>
  BANCO_NOMES_CURTOS[trim(cod)] || trim(fallbackNome) || trim(cod);
// Valor formatado pt-BR SEM "R$" (o template ja tem "R$" fixo antes da variavel).
const fmtValor = (v) => N(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 'YYYYMMDD' (ou 'YYYY-MM-DD') -> 'dd/mm/yyyy'
function fmtData(v) {
  const s = trim(v).replace(/\D/g, '');
  if (s.length !== 8) return trim(v);
  return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}
const fmtBRL = (v) => N(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Escapa pra interpolar com seguranca dentro do HTML do e-mail.
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Template baseado em docs/A _ Minimalista _ 1 boleto.html (Design Canvas).
// O HTML do canvas tem ~873KB de CSS verboso — refeito aqui em HTML email-safe
// (tabelas + inline styles) para caber sob o clip de 102KB do Gmail e renderizar
// no Outlook. Logo servido pelo nginx em https://intranew.gnatus.com.br/logo-gnatus.png
// (asset versionado em frontend/public/logo-gnatus.png). Sem botão "Copiar linha
// digitável": JS não roda em e-mail. Botão "Baixar boleto (PDF)" em standby
// (bloco BTN_PDF comentado): quando houver URL do PDF, passar pdfUrl e descomentar.
function montarEmail({ nome, numero, parcela, valor, vencimento, banco, linha }) {
  const venc = fmtData(vencimento);
  const val = fmtBRL(valor);
  const nf = `${numero}${parcela ? '/' + parcela : ''}`;
  const subject = `Boleto em aberto — NF / Pedido ${nf}${venc ? ` (vence ${venc})` : ''}`;

  const text =
    `Olá, ${nome || 'cliente'}.\n\n` +
    `Segue o boleto referente à NF / Pedido ${nf}.\n\n` +
    `Valor: ${val}\n` +
    (venc ? `Vencimento: ${venc}\n` : '') +
    (banco ? `Banco: ${banco}\n` : '') +
    `NF / Pedido: ${nf}\n\n` +
    `Linha digitável:\n${linha}\n\n` +
    `Selecione a linha digitável acima e pague no app do seu banco. ` +
    `Em caso de dúvida, responda este e-mail.\n\n` +
    `Equipe Financeiro Gnatus`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
<tr><td style="padding:28px 32px 8px 32px;">
<img src="https://intranew.gnatus.com.br/logo-gnatus.png" alt="Gnatus" width="64" height="64" style="display:block;border:0;outline:none;text-decoration:none;width:64px;height:64px;margin-bottom:12px;">
<div style="font-size:12px;letter-spacing:1.5px;color:#64748b;text-transform:uppercase;font-weight:600;">Financeiro</div>
<h1 style="margin:6px 0 0 0;font-size:22px;line-height:1.3;font-weight:600;color:#0f172a;">Boleto em aberto</h1>
</td></tr>
<tr><td style="padding:16px 32px 0 32px;font-size:15px;line-height:1.6;color:#0f172a;">
<p style="margin:0 0 12px 0;">Olá, <strong>${esc(nome || 'cliente')}</strong>.</p>
<p style="margin:0 0 20px 0;">Segue o boleto referente à <strong>NF / Pedido ${esc(nf)}</strong>.</p>
</td></tr>
<tr><td style="padding:0 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
<tr>
<td style="padding:12px 0;font-size:13px;color:#64748b;width:40%;">Valor</td>
<td style="padding:12px 0;font-size:15px;color:#0f172a;font-weight:600;text-align:right;">${esc(val)}</td>
</tr>
${venc ? `<tr>
<td style="padding:12px 0;font-size:13px;color:#64748b;border-top:1px solid #f1f5f9;">Vencimento</td>
<td style="padding:12px 0;font-size:15px;color:#0f172a;text-align:right;border-top:1px solid #f1f5f9;">${esc(venc)}</td>
</tr>` : ''}
${banco ? `<tr>
<td style="padding:12px 0;font-size:13px;color:#64748b;border-top:1px solid #f1f5f9;">Banco</td>
<td style="padding:12px 0;font-size:15px;color:#0f172a;text-align:right;border-top:1px solid #f1f5f9;">${esc(banco)}</td>
</tr>` : ''}
<tr>
<td style="padding:12px 0;font-size:13px;color:#64748b;border-top:1px solid #f1f5f9;">NF / Pedido</td>
<td style="padding:12px 0;font-size:15px;color:#0f172a;text-align:right;border-top:1px solid #f1f5f9;">${esc(nf)}</td>
</tr>
</table>
</td></tr>
<tr><td style="padding:24px 32px 0 32px;">
<div style="font-size:13px;color:#64748b;margin-bottom:8px;">Linha digitável</div>
<div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:15px;font-weight:600;color:#0f172a;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;letter-spacing:.3px;word-break:break-all;line-height:1.4;">${esc(linha)}</div>
</td></tr>
<!-- BTN_PDF (standby — habilitar quando URL do PDF estiver disponível):
<tr><td style="padding:16px 32px 4px 32px;" align="left">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;">
<tr><td style="background:#0f172a;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;">
<a href="\${pdfUrl}" style="color:#ffffff;text-decoration:none;">Baixar boleto (PDF)</a>
</td></tr>
</table>
</td></tr>
-->
<tr><td style="padding:20px 32px 4px 32px;font-size:13px;line-height:1.6;color:#64748b;">
Selecione a linha digitável acima e pague no app do seu banco. Em caso de dúvida, responda este e-mail.
</td></tr>
<tr><td style="padding:16px 32px 28px 32px;font-size:14px;color:#0f172a;">
Equipe Financeiro Gnatus
</td></tr>
<tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 32px;font-size:11px;color:#94a3b8;text-align:center;">
Este é um e-mail automático. Para atendimento, responda esta mensagem.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-disparar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const SuriSvc = app.services.Suri || Suri;

    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0);
    let canais = (Array.isArray(req.body?.canais) ? req.body.canais : ['EMAIL'])
      .map(c => trim(c).toUpperCase()).filter(c => c === 'EMAIL' || c === 'WHATSAPP');
    if (!canais.length) canais = ['EMAIL'];

    if (!ids.length) {
      return res.status(400).json({ message: 'Informe ao menos 1 boleto em ids[].' });
    }

    const querWhats = canais.includes('WHATSAPP');
    const querEmail = canais.includes('EMAIL');
    // WhatsApp so dispara se houver template de boleto aprovado (env). Hoje os
    // unicos templates aprovados sao os de cobranca (D-1/D0/D+3) — boleto fica
    // "pendente_template" ate o Meta aprovar.
    const whatsHabilitado = querWhats && !!trim(process.env.SURI_TPL_BOLETO);

    try {
      // 1) Carrega os boletos pedidos (com banco + titulo)
      const inIds = ids.map((_, i) => `@id${i}`).join(',');
      const pIds = {}; ids.forEach((id, i) => { pIds[`id${i}`] = id; });
      const rows = await Pg.connectAndQuery(`
        SELECT r.id, r.id_lote, r.prefixo, r.numero, r.parcela,
               r.cliente_cod, r.cliente_loja, r.nosso_numero,
               r.status_banco, r.disparado_em, r.canais_disparo,
               t.cliente_nome, t.valor, t.vencimento, t.tipo,
               l.banco_cod, l.banco_nome
          FROM tab_boleto_envio_lote_retorno r
          JOIN tab_boleto_envio_lote l ON l.id = r.id_lote
          -- COALESCE em prefixo/parcela porque o INSERT do sincronizar grava ''
          -- (trim de null vira '') e a tab_titulo pode ter NULL — sem COALESCE
          -- o JOIN falha pros titulos sem parcela.
          LEFT JOIN tab_boleto_envio_lote_titulo t
            ON t.id_lote = r.id_lote
           AND COALESCE(t.prefixo, '') = COALESCE(r.prefixo, '')
           AND t.numero = r.numero
           AND COALESCE(t.parcela, '') = COALESCE(r.parcela, '')
           AND t.cliente_cod = r.cliente_cod AND t.cliente_loja = r.cliente_loja
         WHERE r.id IN (${inIds})`, pIds);

      if (!rows.length) return res.status(404).json({ message: 'Nenhum boleto encontrado para os ids informados.' });

      // 2) Contatos + endereco da SA1 e dados extras do SE1 — em lote
      // SA1: e-mail/telefone (envio) + nome completo/endereco/CNPJ (PDF do boleto)
      // SE1: E1_EMISSAO (data documento), E1_VALJUR (juros R$/dia), E1_MULTA (% multa)
      const contatoMap = new Map();
      const se1Map = new Map();   // chave: prefixo|numero|parcela|cliente|loja
      const chaves = [...new Set(rows.map(r => `${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`))].filter(Boolean);
      if (chaves.length) {
        const p = {};
        const ors = chaves.map((k, i) => {
          const [c, l] = k.split('|'); p[`c${i}`] = c; p[`l${i}`] = l;
          return `(sa1.A1_COD = @c${i} AND sa1.A1_LOJA = @l${i})`;
        }).join(' OR ');
        try {
          const sa1 = await Protheus.connectAndQuery(`
            SELECT RTRIM(sa1.A1_COD) cod, RTRIM(sa1.A1_LOJA) loja,
                   RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_CGC) cgc,
                   RTRIM(sa1.A1_EMAIL) email, RTRIM(sa1.A1_DDD) ddd, RTRIM(sa1.A1_TEL) tel,
                   RTRIM(sa1.A1_END) endereco, RTRIM(sa1.A1_BAIRRO) bairro,
                   RTRIM(sa1.A1_MUN) municipio, RTRIM(sa1.A1_EST) uf, RTRIM(sa1.A1_CEP) cep
              FROM SA1010 sa1 WITH (NOLOCK)
             WHERE sa1.D_E_L_E_T_ <> '*' AND (${ors})`, p);
          sa1.forEach(s => contatoMap.set(`${trim(s.cod)}|${trim(s.loja)}`, {
            email: trim(s.email), telefone: `${trim(s.ddd)}${trim(s.tel)}`,
            nome: trim(s.nome), cgc: trim(s.cgc),
            endereco: trim(s.endereco), bairro: trim(s.bairro),
            municipio: trim(s.municipio), uf: trim(s.uf), cep: trim(s.cep)
          }));
        } catch (e) {
          console.warn('boleto-disparar: falha ao buscar contatos SA1 —', e.message);
        }
        // SE1: pega emissao + juros/multa para montar instrucoes do boleto
        try {
          const pE = {};
          const orsE = rows.map((r, i) => {
            pE[`p${i}`] = trim(r.prefixo); pE[`n${i}`] = trim(r.numero);
            pE[`pa${i}`] = trim(r.parcela); pE[`c${i}`] = trim(r.cliente_cod); pE[`l${i}`] = trim(r.cliente_loja);
            return `(se1.E1_PREFIXO = @p${i} AND se1.E1_NUM = @n${i} AND se1.E1_PARCELA = @pa${i} AND se1.E1_CLIENTE = @c${i} AND se1.E1_LOJA = @l${i})`;
          }).join(' OR ');
          // E1_VENCTO = vencimento ORIGINAL (usado pra emitir o boleto no banco).
          // E1_VENCREA = vencimento REAL (com prorrogacoes posteriores). A linha
          // digitavel precisa bater com a do boleto FISICO que o cliente recebeu
          // do banco — entao usamos E1_VENCTO (original), nao E1_VENCREA.
          // Caso descoberto 2026-05-29 com titulo 092647/02 (Itau) prorrogado de
          // 20/06 -> 22/06 apos bordero; linha gerada com 22/06 nao casava com
          // a do PDF do banco (que tinha 20/06).
          const se1 = await Protheus.connectAndQuery(`
            SELECT RTRIM(se1.E1_PREFIXO) prefixo, RTRIM(se1.E1_NUM) numero, RTRIM(se1.E1_PARCELA) parcela,
                   RTRIM(se1.E1_CLIENTE) cliente, RTRIM(se1.E1_LOJA) loja,
                   RTRIM(se1.E1_EMISSAO) emissao, RTRIM(se1.E1_VENCTO) vencto_original,
                   se1.E1_VALJUR juros_dia, se1.E1_MULTA multa_pct
              FROM SE1010 se1 WITH (NOLOCK)
             WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01' AND (${orsE})`, pE);
          se1.forEach(s => se1Map.set(
            `${trim(s.prefixo)}|${trim(s.numero)}|${trim(s.parcela)}|${trim(s.cliente)}|${trim(s.loja)}`,
            {
              emissao: trim(s.emissao),
              venctoOriginal: trim(s.vencto_original),
              jurosDia: N(s.juros_dia),
              multaPct: N(s.multa_pct)
            }
          ));
        } catch (e) {
          console.warn('boleto-disparar: falha ao buscar SE1 (juros/multa) —', e.message);
        }
      }

      const resultados = [];
      let okCount = 0, falhaCount = 0;

      for (const r of rows) {
        const ref = { id: r.id, numero: trim(r.numero), parcela: trim(r.parcela), cliente: trim(r.cliente_nome) };
        const contato = contatoMap.get(`${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`) || { email: '', telefone: '' };

        // status precisa ser REGISTRADO
        if (trim(r.status_banco) !== 'REGISTRADO') {
          falhaCount++;
          resultados.push({ ...ref, status: 'NAO_REGISTRADO', mensagem: `Boleto em status ${trim(r.status_banco) || '—'} — só dá pra disparar REGISTRADO.` });
          continue;
        }

        // 3) Linha digitavel — calculada localmente a partir dos dados base.
        //    O VENCIMENTO usado e' o E1_VENCTO (original do SE1, que foi
        //    usado pra emitir o boleto no banco) e nao o `r.vencimento`
        //    do PG (que pode ter E1_VENCREA = prorrogado). Sem isso, a
        //    linha digitavel nao bate com a do PDF fisico que o cliente
        //    recebeu do banco — caso detectado em 092647/02 Itau, prorrogado
        //    de 20/06 -> 22/06 apos bordero.
        const seKeyL = `${trim(r.prefixo)}|${trim(r.numero)}|${trim(r.parcela)}|${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`;
        const se1L = se1Map.get(seKeyL) || {};
        const venctoCalc = trim(se1L.venctoOriginal) || trim(r.vencimento);
        // Portador de CESSAO (FIDC) -> boleto sai no banco liquidante/conta do
        // fundo (o lote guarda a ag/conta zerada do Protheus). Ver portadorCessao.
        const bko = PortadorCessao.dadosBoleto({
          banco: trim(r.banco_cod), agencia: trim(r.banco_agencia), conta: trim(r.banco_conta)
        });
        const lin = await ProtheusBoleto.linhaDigitavel({
          banco: bko.banco,
          agencia: bko.agencia,
          conta: bko.conta,
          carteira: bko.carteira,
          nossoNumero: trim(r.nosso_numero),
          valor: N(r.valor),
          vencimento: venctoCalc
        });
        const linha = trim(lin.body?.linha_digitavel);
        if (!lin.ok || !linha) {
          falhaCount++;
          resultados.push({
            ...ref, status: 'LINHA_INDISPONIVEL',
            mensagem: lin.body?.mensagem || 'Não foi possível obter a linha digitável no Protheus.',
            codigo_erro: lin.body?.codigo_erro || 'INDISPONIVEL'
          });
          continue;
        }

        const enviados = [];
        const erros = [];

        // 3.5) Gera PDF do boleto (anexo do e-mail). Se falhar, manda email
        // mesmo assim — linha digitavel no HTML cobre o caso.
        let pdfAttachment = null;
        const codigoBarras = trim(lin.body?.codigo_barras);
        if (querEmail && codigoBarras) {
          try {
            // O PDF tem que mostrar o MESMO vencimento usado pra calcular a
            // linha (senao a ficha visualmente diverge do codigo de barras).
            // Usamos venctoCalc = E1_VENCTO original (ja calculado acima).
            const se1 = se1L || { emissao: '', jurosDia: 0, multaPct: 0 };
            const instrucoes = [
              ...(bko.instrucoes || []),                       // cessao: avisos do fundo
              ...BoletoPdf.montarInstrucoes({
                jurosDia: se1.jurosDia, multaPct: se1.multaPct,
                valor: r.valor, vencimento: venctoCalc
              })
            ];
            const pdfBuf = await BoletoPdf.gerarBoletoPdf({
              banco: bko.banco,
              beneficiario: bko.cessao && bko.beneficiarioFinal
                ? { ...bko.beneficiarioFinal, endereco: BENEFICIARIO_GNATUS.endereco }
                : BENEFICIARIO_GNATUS,
              beneficiarioFinal: bko.cessao ? BENEFICIARIO_GNATUS : null,
              pagador: {
                nome: contato.nome || trim(r.cliente_nome), cgc: contato.cgc || '',
                endereco: contato.endereco || '', bairro: contato.bairro || '',
                municipio: contato.municipio || '', uf: contato.uf || '', cep: contato.cep || ''
              },
              valor: N(r.valor), vencimento: venctoCalc,
              numeroDocumento: trim(r.numero),
              dataDocumento: se1.emissao || venctoCalc,
              nossoNumero: trim(r.nosso_numero) || trim(lin.body?.nosso_numero),
              agencia: bko.agencia, conta: bko.conta,
              carteira: CARTEIRA_LABEL[trim(lin.body?.carteira)] || trim(lin.body?.carteira) || (bko.banco === '033' ? 'PENH. ELETR' : '109'),
              especieDoc: bko.especie || ESPECIE_POR_BANCO[bko.banco] || 'DM',
              linhaDigitavel: linha, codigoBarras, instrucoes
            });
            const fname = `boleto_${trim(r.numero)}${trim(r.parcela) ? '-' + trim(r.parcela) : ''}.pdf`;
            pdfAttachment = { name: fname, contentType: 'application/pdf', content: pdfBuf };
          } catch (e) {
            console.warn('boleto-disparar: falha ao gerar PDF —', e.message);
          }
        }

        // 4) E-mail
        if (querEmail) {
          if (!contato.email) {
            erros.push('sem e-mail no cadastro (SA1)');
          } else {
            try {
              const { subject, text, html } = montarEmail({
                nome: trim(r.cliente_nome), numero: trim(r.numero), parcela: trim(r.parcela),
                valor: r.valor, vencimento: r.vencimento,
                banco: nomeBancoCurto(r.banco_cod, r.banco_nome), linha
              });
              await Email.sendEmail({
                from: Email.SENDER_COBRANCA,   // boleto ao cliente sai de cobranca@ (nao do remetente global ti@)
                to: contato.email, subject, text, html,
                attachments: pdfAttachment ? [pdfAttachment] : undefined
              });
              enviados.push('EMAIL');
            } catch (e) {
              erros.push('e-mail: ' + e.message);
            }
          }
        }

        // 5) WhatsApp — template 'BOLETO' (envio_boleto, Utility)
        if (querWhats) {
          if (!whatsHabilitado) {
            erros.push('whatsapp: pendente_template (SURI_TPL_BOLETO não configurado)');
          } else if (!contato.telefone) {
            erros.push('whatsapp: sem telefone no cadastro (SA1)');
          } else {
            const phone = SuriSvc.normalizePhone(contato.telefone);
            if (!phone) {
              erros.push(`whatsapp: telefone inválido (${contato.telefone})`);
            } else {
              // Ordem dos parametros = {{1}}..{{5}}: nome, NF, valor (sem R$), vencimento, linha
              const params = [
                trim(r.cliente_nome) || 'cliente',
                trim(r.numero),
                fmtValor(r.valor),
                fmtData(r.vencimento),
                linha
              ];
              try {
                const w = await SuriSvc.enviarTemplate({ phone, tipo: 'BOLETO', parameters: params });
                if (w.ok) enviados.push('WHATSAPP');
                else erros.push('whatsapp: ' + (w.erro || 'falha no envio'));
              } catch (e) {
                erros.push('whatsapp: ' + e.message);
              }
            }
          }
        }

        if (enviados.length) {
          // 6) Marca disparo (acumula canais ja disparados antes)
          const canaisAnteriores = trim(r.canais_disparo).split(',').map(s => s.trim()).filter(Boolean);
          const canaisFinais = [...new Set([...canaisAnteriores, ...enviados])].join(',');
          await Pg.connectAndQuery(`
            UPDATE tab_boleto_envio_lote_retorno
               SET disparado_em = NOW(), canais_disparo = @c
             WHERE id = @id`, { id: r.id, c: canaisFinais });

          okCount++;
          resultados.push({ ...ref, status: 'DISPARADO', canais: enviados, avisos: erros.length ? erros : undefined });
        } else {
          falhaCount++;
          resultados.push({ ...ref, status: 'FALHA', mensagem: erros.join('; ') || 'Nenhum canal disponível.' });
        }
      }

      // 7) Auditoria — entidade_id e varchar(80); a lista completa de ids
      // vai no meta.ids (jsonb). Em disparos de 1 item, usa o id direto pra
      // facilitar busca por entidade_id.
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'DISPARO_BOLETO', severidade: falhaCount > 0 ? 'ALERTA' : 'AVISO',
        req, entidade: 'boleto_retorno',
        entidadeId: ids.length === 1 ? String(ids[0]) : `lote_${rows[0]?.id_lote || '?'}_${ids.length}ids`,
        descricao: `Disparou ${okCount} boleto(s) por ${canais.join('+')} (${falhaCount} falha(s) de ${rows.length})`,
        meta: { ids, canais, ok: okCount, falha: falhaCount, total: rows.length }
      });

      return res.json({
        ok: okCount > 0,
        disparados: okCount,
        falhas: falhaCount,
        total: rows.length,
        whatsapp_pendente_template: querWhats && !whatsHabilitado,
        resultados
      });
    } catch (err) {
      console.error('boleto-disparar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
