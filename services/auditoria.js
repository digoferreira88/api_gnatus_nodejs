// Servico de auditoria centralizada — grava em tab_auditoria.
//
// Uso:
//   const Auditoria = require('../../services/auditoria');
//   await Auditoria.registrar(app, {
//     modulo: 'Cobranca',
//     submodulo: 'WhatsApp',
//     acao: 'EXECUTE',
//     severidade: 'AVISO',
//     req,                         // opcional — extrai user/ip/agent
//     entidade: 'titulo_se1',
//     entidadeId: '12345',
//     descricao: 'Disparou template D-1 para 12 clientes',
//     antes: null, depois: null, meta: { total: 12 }
//   });
//
// IMPORTANTE: chamadas falham SILENCIOSAMENTE (catch + console.warn).
// Auditoria nao deve quebrar a operacao principal.

const SEVERIDADES = ['INFO', 'AVISO', 'ALERTA', 'CRITICO'];

// Limite defensivo: descricao truncada e JSONB clamped
const MAX_DESCRICAO = 4000;
const MAX_JSON_KB = 64;

const trim = (v) => v == null ? null : String(v).trim() || null;

function clampJson(obj) {
  if (obj == null) return null;
  try {
    const s = JSON.stringify(obj);
    if (s.length > MAX_JSON_KB * 1024) {
      return { __truncado: true, __motivo: `excedeu ${MAX_JSON_KB}KB`, __preview: s.slice(0, 4000) };
    }
    return obj;
  } catch {
    return { __erro: 'objeto nao serializavel' };
  }
}

function extrairReq(req) {
  if (!req) return {};
  const user = req.user && req.user[0];
  // X-Forwarded-For chain — pega o primeiro
  const fwd = req.headers?.['x-forwarded-for'];
  const ip = (typeof fwd === 'string' ? fwd.split(',')[0].trim() : null)
          || req.ip
          || req.connection?.remoteAddress
          || null;
  return {
    idUsuario: user?.ID || null,
    usuarioEmail: user?.EMAIL || null,
    usuarioNome: user?.NOME || null,
    ip,
    userAgent: req.headers?.['user-agent'] || null
  };
}

async function registrar(app, opts) {
  if (!app?.services?.Pg) return;
  const { Pg } = app.services;
  const sev = SEVERIDADES.includes(opts.severidade) ? opts.severidade : 'INFO';
  const reqInfo = extrairReq(opts.req);

  try {
    await Pg.connectAndQuery(`
      INSERT INTO tab_auditoria (
        modulo, submodulo, acao, severidade,
        id_usuario, usuario_email, usuario_nome, ip, user_agent,
        entidade, entidade_id, descricao,
        antes, depois, meta
      ) VALUES (
        @modulo, @submodulo, @acao, @sev,
        @uid, @uemail, @unome, @ip, @ua,
        @ent, @entid, @desc,
        @antes::jsonb, @depois::jsonb, @meta::jsonb
      )`,
      {
        modulo: trim(opts.modulo) || 'Geral',
        submodulo: trim(opts.submodulo),
        acao: trim(opts.acao) || 'UPDATE',
        sev,
        uid: opts.idUsuario || reqInfo.idUsuario,
        uemail: trim(opts.usuarioEmail) || reqInfo.usuarioEmail,
        unome: trim(opts.usuarioNome) || reqInfo.usuarioNome,
        ip: reqInfo.ip,
        ua: reqInfo.userAgent,
        ent: trim(opts.entidade),
        entid: opts.entidadeId == null ? null : String(opts.entidadeId),
        desc: String(opts.descricao || '').slice(0, MAX_DESCRICAO),
        antes: opts.antes == null ? null : JSON.stringify(clampJson(opts.antes)),
        depois: opts.depois == null ? null : JSON.stringify(clampJson(opts.depois)),
        meta: opts.meta == null ? null : JSON.stringify(clampJson(opts.meta))
      }
    );
  } catch (e) {
    console.warn('[auditoria] falhou ao registrar:', e.message);
  }
}

module.exports = { registrar, SEVERIDADES };
