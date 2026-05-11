// services/contratoAlertas.js
// Cron diario que detecta contratos vencendo em 90/60/30 dias e dispara
// um email pro responsavel interno. Idempotente: a UNIQUE em
// (id_contrato, tipo_alerta, canal, criado_em) impede reenvio do mesmo
// alerta no mesmo dia.

const Email = require('./emailService');

const JANELAS = [
  { dias: 90, tipo: 'VENCIMENTO_90' },
  { dias: 60, tipo: 'VENCIMENTO_60' },
  { dias: 30, tipo: 'VENCIMENTO_30' }
];

function fmtBR (iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}
function fmtMoney (n) {
  return (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function montarCorpoEmail (c, diasParaVencer) {
  const linha1 = `${c.titulo} (${c.numero}) com ${c.contraparte_nome} vence em ${fmtBR(c.vigencia_fim)} — ${diasParaVencer} dias.`;
  return [
    `Olá ${c.responsavel_nome || c.responsavel_email || ''},`,
    '',
    linha1,
    '',
    `Tipo: ${c.tipo}`,
    c.valor_mensal ? `Valor mensal: ${fmtMoney(c.valor_mensal)}` : '',
    c.valor_total  ? `Valor total: ${fmtMoney(c.valor_total)}`   : '',
    c.indice_reajuste ? `Reajuste por: ${c.indice_reajuste}` : '',
    c.renovacao_automatica ? `Renovação automática: SIM (${c.prazo_renovacao_meses || '?'} meses)` : 'Renovação automática: NÃO',
    '',
    'Acesse a Intranet para revisar:',
    `https://intranew.gnatus.com.br/apoio-gerencial/contratos`,
    '',
    '— Sistema automático de alertas',
    '  Intranet GNATUS · Gestão de Contratos'
  ].filter(Boolean).join('\n');
}

// Identifica contratos elegiveis e dispara alertas (1 email por contrato/janela/dia)
async function rodarAlertas (app) {
  const { Pg } = app.services;
  const stats = { contratos_verificados: 0, alertas_enviados: 0, falhas: 0, ja_enviados_hoje: 0, sem_destinatario: 0, por_janela: {} };

  try {
    // Pega contratos com vigencia_fim definida, nao encerrados, e dias_para_vencimento em {30, 60, 90}
    // (calculo via SQL: vigencia_fim - hoje em dias)
    const rows = await Pg.connectAndQuery(`
      SELECT c.*,
             (c.vigencia_fim - CURRENT_DATE)::int AS dias_para_vencer,
             u.email AS responsavel_email_user
        FROM tab_contrato c
        LEFT JOIN tab_intranet_usr u ON u.id = c.id_user_responsavel
       WHERE c.encerrado = false
         AND c.vigencia_fim IS NOT NULL
         AND (c.vigencia_fim - CURRENT_DATE) IN (30, 60, 90)`,
      {}
    );
    stats.contratos_verificados = rows.length;

    for (const c of rows) {
      const dias = c.dias_para_vencer;
      const janela = JANELAS.find(j => j.dias === dias);
      if (!janela) continue;
      stats.por_janela[janela.tipo] = (stats.por_janela[janela.tipo] || 0) + 1;

      // Destinatario: email do responsavel (campo explicito > email do user vinculado)
      const dest = (c.responsavel_email || c.responsavel_email_user || '').trim();
      if (!dest) {
        stats.sem_destinatario++;
        console.warn(`[contrato-alerta] contrato ${c.numero} sem destinatario — pulando`);
        continue;
      }

      // Verifica se ja foi enviado HOJE pra esse contrato/janela
      const jaEnv = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_contrato_alerta
          WHERE id_contrato = @id AND tipo_alerta = @tp AND canal = 'EMAIL'
            AND criado_em::date = CURRENT_DATE LIMIT 1`,
        { id: c.id, tp: janela.tipo }
      );
      if (jaEnv.length) { stats.ja_enviados_hoje++; continue; }

      try {
        const subject = `[CONTRATO ${c.numero}] Vence em ${dias} dias — ${c.titulo}`;
        const text = montarCorpoEmail(c, dias);
        await Email.sendEmail({ to: dest, subject, text });

        await Pg.connectAndQuery(
          `INSERT INTO tab_contrato_alerta (id_contrato, tipo_alerta, canal, destinatario, status, detalhe)
           VALUES (@id, @tp, 'EMAIL', @dest, 'ENVIADO', @det)`,
          { id: c.id, tp: janela.tipo, dest, det: `Alerta ${dias}d antes do vencimento` }
        );
        stats.alertas_enviados++;
      } catch (e) {
        stats.falhas++;
        try {
          await Pg.connectAndQuery(
            `INSERT INTO tab_contrato_alerta (id_contrato, tipo_alerta, canal, destinatario, status, detalhe)
             VALUES (@id, @tp, 'EMAIL', @dest, 'FALHA', @det)`,
            { id: c.id, tp: janela.tipo, dest, det: e.message.slice(0, 500) }
          );
        } catch {}
        console.error(`[contrato-alerta] falha pra contrato ${c.numero}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[contrato-alerta] erro:', err);
    stats.erro = err.message;
  }

  return stats;
}

module.exports = { rodarAlertas, JANELAS };
