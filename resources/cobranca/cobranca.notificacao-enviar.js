// POST /cobranca/notificacao-enviar — envia a notificação formal (protesto) por
// e-mail (cobranca@) e/ou WhatsApp (template Suri).
//
// Body: {
//   tipo: 'PROTESTO',
//   canais: ['EMAIL', 'WHATSAPP'],
//   titulos: [{ prefixo, numero, parcela, tipo, cliente_cod, cliente_loja, banco? }],
//   teste?: { email?, telefone? }     // manda SÓ para esse contato, sem registrar
// }
//
// - Re-consulta o Protheus: título pago/fora do universo é ignorado.
// - E-mail: um por cliente (todos os títulos dele) + quadro "IMPORTANTE".
// - WhatsApp: um por título.
// - Trava 1 envio por título × canal × dia (reserva antes de mandar).
// - Deixa um comentário no Cliente 360° com o que foi enviado.
// A tela manda no máximo ~10 títulos por chamada, sem partir um cliente.
// Perm 9009.

const crypto = require('crypto');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9009]);
const Notif = require('../../services/cobrancaNotificacao');
const Email = require('../../services/emailService');
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v == null ? '' : v).trim();
const MAX_TITULOS = 60;

const ref = (t) => ({
  chave: t.chave, cliente: t.cliente_nome, cliente_cod: t.cliente_cod, cliente_loja: t.cliente_loja,
  titulo: Notif.numTitulo(t)
});

module.exports = (app) => ({
  verb: 'post',
  route: '/notificacao-enviar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Suri } = app.services;
    const user = req.user && req.user[0];
    const cfg = Notif.tipoCfg(req.body?.tipo);
    if (!cfg) return res.status(400).json({ message: 'Tipo de notificação inválido.' });

    const canais = [...new Set((Array.isArray(req.body?.canais) ? req.body.canais : [])
      .map(c => trim(c).toUpperCase()).filter(c => c === 'EMAIL' || c === 'WHATSAPP'))];
    if (!canais.length) return res.status(400).json({ message: 'Escolha ao menos um canal (e-mail ou WhatsApp).' });

    const titulosBody = Array.isArray(req.body?.titulos) ? req.body.titulos : [];
    if (!titulosBody.length) return res.status(400).json({ message: 'Selecione ao menos 1 título.' });
    if (titulosBody.length > MAX_TITULOS) {
      return res.status(400).json({ message: `Máximo de ${MAX_TITULOS} títulos por chamada.` });
    }

    const teste = req.body?.teste && typeof req.body.teste === 'object' ? req.body.teste : null;

    try {
      // ------------------------------------------------------------------
      // TESTE: manda o conteúdo real de UM cliente para o contato informado.
      // Não reserva, não registra, não comenta no 360.
      // ------------------------------------------------------------------
      if (teste) {
        const emailTeste = Notif.emailsValidos(teste.email)[0] || null;
        const foneTeste = trim(teste.telefone) ? Suri.normalizePhone(teste.telefone) : null;
        if (canais.includes('EMAIL') && !emailTeste) return res.status(400).json({ message: 'Informe um e-mail de teste válido.' });
        if (canais.includes('WHATSAPP') && !foneTeste) return res.status(400).json({ message: 'Informe um WhatsApp de teste válido (DDD + número).' });

        const ck0 = `${trim(titulosBody[0].cliente_cod)}|${trim(titulosBody[0].cliente_loja)}`;
        const doCliente = titulosBody.filter(b => `${trim(b.cliente_cod)}|${trim(b.cliente_loja)}` === ck0);
        const { pacotes } = await Notif.carregarPacotes(app.services, cfg.tipo, doCliente);
        const pac = pacotes[0];
        if (!pac) return res.status(404).json({ message: 'Os títulos não estão mais em aberto e vencidos no Protheus.' });

        const resultados = [];
        if (canais.includes('EMAIL')) {
          const { assunto, html, texto } = Notif.montarEmail({ tipo: cfg.tipo, cliente: pac.cliente, titulos: pac.titulos, outros: pac.outros });
          try {
            await Email.sendEmail({ from: Email.SENDER_COBRANCA, to: emailTeste, subject: `[TESTE] ${assunto}`, text: texto, html });
            resultados.push({ canal: 'EMAIL', status: 'OK', destino: emailTeste });
          } catch (e) {
            resultados.push({ canal: 'EMAIL', status: 'ERRO', destino: emailTeste, erro: e.message });
          }
        }
        if (canais.includes('WHATSAPP')) {
          for (const t of pac.titulos.slice(0, 3)) {
            const r = await Notif.enviarWhatsapp(Suri, cfg.tipo, { phone: foneTeste, parametros: Notif.parametrosWhatsapp(t, pac.cliente) });
            resultados.push({ canal: 'WHATSAPP', titulo: Notif.numTitulo(t), status: r.ok ? 'OK' : 'ERRO', destino: foneTeste, erro: r.erro || undefined });
          }
        }
        Auditoria.registrar(app, {
          modulo: 'Cobranca', submodulo: 'Notificacao', acao: 'TESTE', severidade: 'INFO',
          req, entidade: 'cliente', entidadeId: ck0,
          descricao: `Teste de notificação ${cfg.tipo} do cliente ${pac.cliente.nome} enviado para ${[emailTeste, foneTeste].filter(Boolean).join(' / ')}`,
          meta: { canais, resultados }
        });
        return res.json({ ok: resultados.some(r => r.status === 'OK'), teste: true, resultados });
      }

      // ------------------------------------------------------------------
      // ENVIO REAL
      // ------------------------------------------------------------------
      await Notif.liberarTravados(Pg);
      const { pacotes, ignorados } = await Notif.carregarPacotes(app.services, cfg.tipo, titulosBody);
      const dia = Notif.hojeBR();
      const envioId = crypto.randomUUID();
      const idUser = user ? user.ID : null;
      const resultados = [];

      for (const pac of pacotes) {
        const enviadosEmail = [];
        const enviadosWhats = [];
        // Sem banco a mensagem sairia com "Banco: —": a tela obriga a informar.
        const semBanco = pac.titulos.filter(t => !trim(t.banco));
        semBanco.forEach(t => canais.forEach(canal => resultados.push({
          ...ref(t), canal, status: 'SEM_BANCO', erro: 'Informe o banco do título antes de notificar.'
        })));
        const titulos = pac.titulos.filter(t => trim(t.banco));
        if (!titulos.length) continue;

        // ---- E-mail: um por cliente ----
        if (canais.includes('EMAIL')) {
          const para = pac.cliente.emails;
          if (!para.length) {
            titulos.forEach(t => resultados.push({ ...ref(t), canal: 'EMAIL', status: 'SEM_CONTATO', erro: 'Cliente sem e-mail válido no cadastro (SA1).' }));
          } else {
            const destino = para.join('; ');
            const reservas = [];
            for (const t of titulos) {
              const id = await Notif.reservar(Pg, { tipo: cfg.tipo, canal: 'EMAIL', dia, titulo: t, destino, parametros: null, idUser, envioId });
              if (id) reservas.push({ id, t });
              else resultados.push({ ...ref(t), canal: 'EMAIL', status: 'JA_NOTIFICADO', erro: 'Já notificado hoje por e-mail.' });
            }
            if (reservas.length) {
              const { assunto, html, texto } = Notif.montarEmail({
                tipo: cfg.tipo, cliente: pac.cliente, titulos: reservas.map(r => r.t), outros: pac.outros
              });
              try {
                await Email.sendEmail({ from: Email.SENDER_COBRANCA, to: para.join(';'), subject: assunto, text: texto, html });
                await Notif.finalizar(Pg, reservas.map(r => r.id), { status: 'OK' });
                reservas.forEach(r => { resultados.push({ ...ref(r.t), canal: 'EMAIL', status: 'OK', destino }); enviadosEmail.push(r.t); });
              } catch (e) {
                await Notif.finalizar(Pg, reservas.map(r => r.id), { status: 'ERRO', erro: e.message });
                reservas.forEach(r => resultados.push({ ...ref(r.t), canal: 'EMAIL', status: 'ERRO', erro: e.message }));
              }
            }
          }
        }

        // ---- WhatsApp: um por título ----
        if (canais.includes('WHATSAPP')) {
          const fone = pac.cliente.telefone;
          for (const t of titulos) {
            if (!fone) {
              resultados.push({ ...ref(t), canal: 'WHATSAPP', status: 'SEM_CONTATO', erro: 'Cliente sem telefone válido no cadastro (SA1).' });
              continue;
            }
            const parametros = Notif.parametrosWhatsapp(t, pac.cliente);
            const id = await Notif.reservar(Pg, { tipo: cfg.tipo, canal: 'WHATSAPP', dia, titulo: t, destino: fone, parametros, idUser, envioId });
            if (!id) {
              resultados.push({ ...ref(t), canal: 'WHATSAPP', status: 'JA_NOTIFICADO', erro: 'Já notificado hoje por WhatsApp.' });
              continue;
            }
            let r;
            try {
              r = await Notif.enviarWhatsapp(Suri, cfg.tipo, { phone: fone, parametros });
            } catch (e) {
              r = { ok: false, erro: e.message };
            }
            await Notif.finalizar(Pg, id, { status: r.ok ? 'OK' : 'ERRO', erro: r.erro, wamid: r.wamid, response: r.raw });
            if (r.ok) { resultados.push({ ...ref(t), canal: 'WHATSAPP', status: 'OK', destino: fone }); enviadosWhats.push(t); }
            else resultados.push({ ...ref(t), canal: 'WHATSAPP', status: 'ERRO', erro: r.erro });
          }
        }

        // ---- Registro no Cliente 360° (comentário) ----
        const notificados = [...new Map([...enviadosEmail, ...enviadosWhats].map(t => [t.chave, t])).values()];
        if (notificados.length && idUser) {
          const canaisTxt = [
            enviadosEmail.length ? `e-mail (${pac.cliente.emails.join(', ')})` : null,
            enviadosWhats.length ? `WhatsApp (${pac.cliente.telefone})` : null
          ].filter(Boolean).join(' e ');
          const titsTxt = notificados.map(t =>
            `${Notif.numTitulo(t)} — ${Notif.fmtBRL(t.saldo)}, venc. ${Notif.fmtData(t.vencimento)}, ${t.dias_atraso} dias, banco ${t.banco}`
          ).join('; ');
          const texto = `[Notificação automática] ${cfg.titulo} enviada por ${canaisTxt}. Título(s): ${titsTxt}.` +
            (pac.outros.length ? ` Citados como pendência sem ordem de protesto: ${pac.outros.map(Notif.numTitulo).join(', ')}.` : '');
          await Pg.connectAndQuery(
            `INSERT INTO tab_cobranca_comentario (cliente_cod, cliente_loja, id_user, texto)
             VALUES (@cod, @loja, @uid::int, @texto)`,
            { cod: pac.cliente.cod, loja: pac.cliente.loja, uid: idUser, texto }
          ).catch(e => console.warn('notificacao-enviar: comentário no 360 falhou —', e.message));
        }
      }

      const conta = (st) => resultados.filter(r => r.status === st).length;
      const resumo = {
        ok: conta('OK'), erro: conta('ERRO'), sem_contato: conta('SEM_CONTATO'),
        sem_banco: conta('SEM_BANCO'), ja_notificado: conta('JA_NOTIFICADO'),
        ignorados: ignorados.length, clientes: pacotes.length
      };

      Auditoria.registrar(app, {
        modulo: 'Cobranca', submodulo: 'Notificacao', acao: 'EXECUTE',
        severidade: resumo.erro > 0 ? 'ALERTA' : 'AVISO',
        req, entidade: 'notificacao_envio', entidadeId: envioId,
        descricao: `Notificação ${cfg.tipo} por ${canais.join('+')}: ${resumo.ok} envio(s) OK, ${resumo.erro} erro(s), ` +
          `${resumo.sem_contato} sem contato, ${resumo.ja_notificado} já notificado(s) hoje, ${resumo.ignorados} ignorado(s) — ${resumo.clientes} cliente(s)`,
        meta: { tipo: cfg.tipo, canais, resumo, ignorados, titulos: titulosBody.length }
      });

      return res.json({
        ok: resumo.ok > 0,
        envio_id: envioId,
        // Fora de produção o e-mail só é logado (emailService) — avisa a tela.
        simulado: process.env.NODE_ENV !== 'production' ? true : undefined,
        resumo,
        resultados,
        ignorados
      });
    } catch (err) {
      console.error('cobranca/notificacao-enviar:', err);
      return res.status(500).json({ message: 'Erro no envio: ' + err.message });
    }
  }
});
