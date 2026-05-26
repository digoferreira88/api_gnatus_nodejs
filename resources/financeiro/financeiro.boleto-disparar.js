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
const Email = require('../../services/emailService');
const Suri = require('../../services/suri');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);
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

function montarEmail({ nome, numero, parcela, valor, vencimento, banco, linha }) {
  const venc = fmtData(vencimento);
  const val = fmtBRL(valor);
  const nf = `${numero}${parcela ? '/' + parcela : ''}`;
  const subject = `Boleto Gnatus — NF / Pedido ${nf}${venc ? ` (vence ${venc})` : ''}`;

  const text =
    `Olá, ${nome || 'cliente'}!\n\n` +
    `Segue o boleto referente à NF ${nf}.\n` +
    `Valor: ${val}\n` +
    (venc ? `Vencimento: ${venc}\n` : '') +
    (banco ? `Banco: ${banco}\n` : '') +
    `\nLinha digitável:\n${linha}\n\n` +
    `Basta copiar a linha digitável acima e pagar no app do seu banco.\n\n` +
    `Equipe Financeiro Gnatus`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;max-width:560px">` +
    `<p>Olá, <strong>${esc(nome || 'cliente')}</strong>!</p>` +
    `<p>Segue o boleto referente à <strong>NF ${esc(nf)}</strong>.</p>` +
    `<table style="border-collapse:collapse;margin:12px 0">` +
    `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">Valor</td><td style="padding:2px 0"><strong>${esc(val)}</strong></td></tr>` +
    (venc ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">Vencimento</td><td style="padding:2px 0">${esc(venc)}</td></tr>` : '') +
    (banco ? `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">Banco</td><td style="padding:2px 0">${esc(banco)}</td></tr>` : '') +
    `</table>` +
    `<p style="margin-bottom:4px;color:#6b7280">Linha digitável:</p>` +
    `<p style="font-family:'Courier New',monospace;font-size:16px;font-weight:bold;background:#f3f4f6;` +
    `border:1px solid #e5e7eb;border-radius:6px;padding:12px;letter-spacing:.5px;word-break:break-all">${esc(linha)}</p>` +
    `<p style="color:#6b7280">Basta copiar a linha digitável acima e pagar no app do seu banco.</p>` +
    `<p style="margin-top:20px">Equipe Financeiro Gnatus</p>` +
    `</div>`;

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
          LEFT JOIN tab_boleto_envio_lote_titulo t
            ON t.id_lote = r.id_lote AND t.prefixo = r.prefixo AND t.numero = r.numero
           AND t.parcela = r.parcela AND t.cliente_cod = r.cliente_cod AND t.cliente_loja = r.cliente_loja
         WHERE r.id IN (${inIds})`, pIds);

      if (!rows.length) return res.status(404).json({ message: 'Nenhum boleto encontrado para os ids informados.' });

      // 2) Contatos (e-mail) da SA1 — em lote
      const contatoMap = new Map();
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
                   RTRIM(sa1.A1_EMAIL) email, RTRIM(sa1.A1_DDD) ddd, RTRIM(sa1.A1_TEL) tel
              FROM SA1010 sa1 WITH (NOLOCK)
             WHERE sa1.D_E_L_E_T_ <> '*' AND (${ors})`, p);
          sa1.forEach(s => contatoMap.set(`${trim(s.cod)}|${trim(s.loja)}`, {
            email: trim(s.email), telefone: `${trim(s.ddd)}${trim(s.tel)}`
          }));
        } catch (e) {
          console.warn('boleto-disparar: falha ao buscar contatos SA1 —', e.message);
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

        // 3) Linha digitavel via Protheus (Diego)
        const lin = await ProtheusBoleto.linhaDigitavel({
          filial: '01',
          prefixo: trim(r.prefixo), numero: trim(r.numero), parcela: trim(r.parcela),
          cliente: trim(r.cliente_cod), loja: trim(r.cliente_loja), tipo: trim(r.tipo)
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

        // 4) E-mail
        if (querEmail) {
          if (!contato.email) {
            erros.push('sem e-mail no cadastro (SA1)');
          } else {
            try {
              const { subject, text, html } = montarEmail({
                nome: trim(r.cliente_nome), numero: trim(r.numero), parcela: trim(r.parcela),
                valor: r.valor, vencimento: r.vencimento, banco: trim(r.banco_nome) || trim(r.banco_cod), linha
              });
              await Email.sendEmail({ to: contato.email, subject, text, html });
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

      // 7) Auditoria
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'DISPARO_BOLETO', severidade: falhaCount > 0 ? 'ALERTA' : 'AVISO',
        req, entidade: 'boleto_retorno', entidadeId: ids.join(','),
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
