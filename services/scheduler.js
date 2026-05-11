// Scheduler central — agenda jobs cron via node-schedule.
//
// Atualmente roda 1 job:
//   - cobranca-whatsapp-disparo: 09:00 todo dia. Verifica titulos SE1
//     vencendo amanha (D-1), hoje (D0) e vencidos ha 3 dias sem pagamento
//     (D+3) e dispara templates WhatsApp via SURI.
//
// O scheduler so liga se a flag PG `tab_cobranca_whatsapp_config(automacao_ativa)`
// estiver 'true' — assim a UI de Tecnologia liga/desliga sem precisar mexer em
// codigo nem reiniciar o backend.
//
// Inicializacao: chame `Scheduler.start(app)` no index.js apos o registro de
// rotas e services.

const schedule = require('node-schedule');

const jobs = {};
const CRON_DIARIO = '0 9 * * *';  // 09:00 todo dia

// Tipos de disparo + delta de dias e modo de comparacao do vencimento.
//   mode 'exato' = E1_VENCREA exatamente igual a (hoje + delta)
//   mode 'desde' = E1_VENCREA <= (hoje + delta)  — "X ou mais dias atras"
const TIPOS = [
  { tipo: 'D-1', delta: 1,  mode: 'exato', desc: 'lembrete amanha' },     // amanha
  { tipo: 'D0',  delta: 0,  mode: 'exato', desc: 'vencimento hoje' },     // hoje
  { tipo: 'D+3', delta: -3, mode: 'desde', desc: 'atraso 3+ dias' }        // venceu ha 3+ dias
];

const fmtDataBR = (ymd) => {
  if (!ymd || String(ymd).length !== 8) return '';
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
};
const fmtMoeda = (n) => Number(n || 0).toLocaleString('pt-BR', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

// Soma `delta` dias na data atual e retorna no formato YYYYMMDD (Protheus).
function ymdComOffset(deltaDias) {
  const d = new Date();
  d.setDate(d.getDate() + deltaDias);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// Busca titulos no Protheus pra um delta especifico.
//   mode 'exato' (default): E1_VENCREA EXATAMENTE igual a (hoje + delta)
//   mode 'desde': E1_VENCREA <= (hoje + delta)  — pra D+3 (3 ou mais dias atrasado)
//                 Inclui DATEDIFF como dias_atraso pra ordenar/filtrar no JS.
async function buscarTitulos(Protheus, deltaDias, mode = 'exato') {
  const ymd = ymdComOffset(deltaDias);
  const condVenc = mode === 'desde'
    ? `CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, @ymd, 112)`
    : `CONVERT(date, se1.E1_VENCREA, 112)  = CONVERT(date, @ymd, 112)`;
  return Protheus.connectAndQuery(`
    SELECT
      RTRIM(se1.E1_FILIAL)  filial,
      RTRIM(se1.E1_PREFIXO) prefixo,
      RTRIM(se1.E1_NUM)     numero,
      RTRIM(se1.E1_PARCELA) parcela,
      RTRIM(se1.E1_CLIENTE) cliente_cod,
      RTRIM(se1.E1_LOJA)    cliente_loja,
      RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) cliente_nome,
      RTRIM(sa1.A1_DDD)     ddd,
      RTRIM(sa1.A1_TEL)     tel_fixo,
      RTRIM(sa1.A1_DDDCEL)  dddcel,
      RTRIM(sa1.A1_PESSOA)  pessoa,
      se1.E1_VALOR          valor,
      se1.E1_SALDO          saldo,
      RTRIM(se1.E1_VENCREA) vencimento,
      RTRIM(se1.E1_NUM)     nf,
      RTRIM(se1.E1_FORMAPG) forma_pgto,
      DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, GETDATE())) dias_atraso
    FROM SE1010 se1 WITH (NOLOCK)
    LEFT JOIN SA1010 sa1 WITH (NOLOCK)
      ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA
     AND sa1.D_E_L_E_T_ <> '*'
    WHERE se1.D_E_L_E_T_ <> '*'
      AND se1.E1_FILIAL = '01'
      AND se1.E1_SALDO > 0
      AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
      AND ${condVenc}
    ORDER BY se1.E1_VENCREA, se1.E1_CLIENTE`,
    { ymd }
  );
}

// Pega telefone do SA1: prefere celular (DDDCEL), fallback fixo (DDD+TEL).
// O A1_DDDCEL no Protheus geralmente vem com 0 a esquerda — strip.
function extrairTelefone(row, suri) {
  const dddCel = String(row.dddcel || '').replace(/\D/g, '').replace(/^0+/, '');
  if (dddCel) {
    const phone = suri.normalizePhone(dddCel);
    if (phone) return phone;
  }
  // fallback
  const ddd = String(row.ddd || '').replace(/\D/g, '');
  const tel = String(row.tel_fixo || '').replace(/\D/g, '');
  if (ddd && tel) return suri.normalizePhone(ddd + tel);
  if (tel) return suri.normalizePhone(tel);
  return null;
}

// Monta os parametros do template conforme o tipo.
//   D-1: [nome, vencimento, nf, valor]    -> 4
//   D0:  [nome, nf, valor]                -> 3
//   D+3: [nome, nf, valor, vencimento]    -> 4
function montarParametros(tipo, row) {
  const nome  = String(row.cliente_nome || 'Cliente').split(/\s+/)[0]; // primeiro nome
  const venc  = fmtDataBR(row.vencimento);
  const nf    = row.numero || '—';
  const valor = fmtMoeda(row.saldo);
  switch (tipo) {
    case 'D-1': return [nome, venc, nf, valor];
    case 'D0':  return [nome, nf, valor];
    case 'D+3': return [nome, nf, valor, venc];
    default: return [];
  }
}

// Verifica flag automacao_ativa no PG.
async function automacaoAtiva(Pg) {
  const r = await Pg.connectAndQuery(
    `SELECT valor FROM tab_cobranca_whatsapp_config WHERE chave = 'automacao_ativa'`,
    {}
  );
  return r.length > 0 && String(r[0].valor).toLowerCase() === 'true';
}

// Roda o disparo completo (D-1, D0, D+3). Retorna stats.
// `force=true` ignora o flag (usado pelo botao manual).
async function rodarDisparo(app, { force = false } = {}) {
  const { Pg, Protheus, Suri } = app.services;
  const stats = { iniciado_em: new Date().toISOString(), totais: {} };

  if (!force && !(await automacaoAtiva(Pg))) {
    stats.skip = 'automacao desligada';
    console.log('[scheduler] cobranca-whatsapp: automacao desligada — pulando');
    return stats;
  }

  for (const cfg of TIPOS) {
    const tipoStat = { encontrados: 0, enviados: 0, erros: 0, sem_telefone: 0, ja_enviados: 0 };
    try {
      const titulos = await buscarTitulos(Protheus, cfg.delta, cfg.mode);
      tipoStat.encontrados = titulos.length;

      for (const t of titulos) {
        const phone = extrairTelefone(t, Suri);
        const parametros = montarParametros(cfg.tipo, t);

        // Se sem telefone: loga SEM_TELEFONE (idempotencia tambem evita re-loga)
        if (!phone) {
          await registrarEnvio(Pg, t, cfg.tipo, {
            status: 'SEM_TELEFONE', telefone: null, parametros, erro: 'Sem telefone valido em SA1'
          }).catch(() => { tipoStat.ja_enviados++; });
          tipoStat.sem_telefone++;
          continue;
        }

        // Tenta enviar
        const r = await Suri.enviarTemplate({ phone, tipo: cfg.tipo, parameters: parametros });

        try {
          await registrarEnvio(Pg, t, cfg.tipo, {
            status: r.ok ? 'OK' : 'ERRO',
            telefone: phone, parametros,
            wamid: r.wamid, erro: r.erro, response: r.raw
          });
          if (r.ok) tipoStat.enviados++;
          else tipoStat.erros++;
        } catch (e) {
          // unique violation = ja enviado hoje (idempotencia)
          if (String(e.message).match(/duplicate|unique/i)) {
            tipoStat.ja_enviados++;
          } else {
            console.error('[scheduler] erro ao logar envio:', e.message);
            tipoStat.erros++;
          }
        }
      }
    } catch (err) {
      console.error(`[scheduler] erro no disparo ${cfg.tipo}:`, err.message);
      tipoStat.erro_query = err.message;
    }
    stats.totais[cfg.tipo] = tipoStat;
    console.log(`[scheduler] ${cfg.tipo} (${cfg.desc}):`, tipoStat);
  }

  stats.terminado_em = new Date().toISOString();
  return stats;
}

async function registrarEnvio(Pg, titulo, tipo, info) {
  return Pg.connectAndQuery(`
    INSERT INTO tab_cobranca_whatsapp_envio (
      filial, prefixo, numero, parcela, cliente_cod, cliente_loja, cliente_nome,
      tipo, telefone, template_nome, template_id, parametros, valor_titulo, vencimento,
      status, wamid, erro, response_json
    ) VALUES (
      @filial, @prefixo, @numero, @parcela, @cliente_cod, @cliente_loja, @cliente_nome,
      @tipo, @telefone, @template_nome, @template_id, @parametros::jsonb,
      @valor_titulo, TO_DATE(@vencimento, 'YYYYMMDD'),
      @status, @wamid, @erro, @response_json::jsonb
    )`,
    {
      filial: titulo.filial, prefixo: titulo.prefixo, numero: titulo.numero,
      parcela: titulo.parcela || '',
      cliente_cod: titulo.cliente_cod, cliente_loja: titulo.cliente_loja,
      cliente_nome: titulo.cliente_nome,
      tipo, telefone: info.telefone,
      template_nome: tipo === 'D-1' ? 'cobrancalembreted1'
                   : tipo === 'D0'  ? 'cobrancavencimentod0'
                   : 'cobrancaatrasod3',
      template_id: null,  // app.services.Suri.TEMPLATES[tipo] — opcional, evita acoplamento
      parametros: JSON.stringify(info.parametros || []),
      valor_titulo: Number(titulo.saldo || 0),
      vencimento: titulo.vencimento,
      status: info.status,
      wamid: info.wamid || null,
      erro: info.erro || null,
      response_json: info.response ? JSON.stringify(info.response) : null
    }
  );
}

// Cron de alertas de contratos roda 30min antes do cobranca-whatsapp pra
// nao competir conexao Protheus/PG, e antes do horario comercial.
const CRON_CONTRATOS = '30 8 * * *';  // 08:30 todo dia

function start(app) {
  if (jobs.cobranca) jobs.cobranca.cancel();
  jobs.cobranca = schedule.scheduleJob(CRON_DIARIO, async () => {
    console.log('[scheduler] disparo cobranca-whatsapp iniciado:', new Date().toISOString());
    try {
      await rodarDisparo(app);
    } catch (err) {
      console.error('[scheduler] erro fatal no disparo cobranca:', err.message);
    }
  });
  console.log(`[scheduler] cobranca-whatsapp agendado: cron "${CRON_DIARIO}"`);

  // Contratos - alertas de vencimento (D-90/D-60/D-30 por email)
  if (jobs.contratos) jobs.contratos.cancel();
  jobs.contratos = schedule.scheduleJob(CRON_CONTRATOS, async () => {
    console.log('[scheduler] alertas de contrato iniciado:', new Date().toISOString());
    try {
      const ContratoAlertas = require('./contratoAlertas');
      const stats = await ContratoAlertas.rodarAlertas(app);
      console.log('[scheduler] alertas de contrato concluido:', stats);
    } catch (err) {
      console.error('[scheduler] erro nos alertas de contrato:', err.message);
    }
  });
  console.log(`[scheduler] contratos agendado: cron "${CRON_CONTRATOS}"`);
}

function stop() {
  Object.values(jobs).forEach(j => j && j.cancel());
}

module.exports = {
  start, stop, rodarDisparo,
  // helpers expostos pra serem reusados por endpoints (preview/enviar manual)
  buscarTitulos, extrairTelefone, montarParametros, registrarEnvio,
  TIPOS, fmtDataBR, fmtMoeda
};
