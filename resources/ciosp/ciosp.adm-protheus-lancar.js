// POST /ciosp/adm/protheus/:uuid/lancar — botão "Inserir no Protheus e finalizar" da
// fila do ADM. Perm 19004. ESCRITA NO ERP (pelo REST do Diego, PedidoVenda/incluir).
// Spec 2026-11-13-ciosp-inserir-protheus-design.md, seção 6.2.
//
// A ordem é a garantia de não duplicar nem perder o número:
//   1. valida fora de transação (lê o Protheus: rede não segura trava);
//   2. transação curta: trava o pedido, confere tudo de novo, marca "enviando" e grava
//      a tentativa — dois cliques ou duas abas: o segundo recebe 409;
//   3. chama o Protheus sem trava (até 180 s). O endpoint não duplica: id_externo =
//      700.000 + id, e um reenvio depois de timeout recebe JA_EXISTIA;
//   4. transação de fechamento: grava a resposta; criado → nº, cliente e finalizar
//      (painel "Ok"). Se finalizar falhar, o nº fica (savepoint) e a tela avisa.
// Se o passo 4 nem acontecer, o pedido fica "enviando"; depois de 4 minutos o "Tentar
// de novo" é liberado e recebe JA_EXISTIA.
//
// CIOSP_PROTHEUS_ATIVO=1 liga; CIOSP_PROTHEUS_SIMULAR=1 manda simular: true e não
// finaliza nem grava número.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const Painel = require('../../services/ciospPainel');
const CP = require('../../services/ciospProtheus');
const P = require('../../services/ciospProtheusProposta');
const E = require('../../services/ciospProtheusEnvio');
const PV = require('../../services/protheusPedidoVenda');
const { q } = require('../../services/ciospEdicao');

const trava = (db, uuid) => q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`ciosp-ped-protheus-${uuid}`]);
const reais = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Só os campos do painel, aparados. TES só dos itens do pedido.
const CAMPOS = {
  cliente_codigo: 6, cliente_loja: 4, genero: 1, nascimento: 10, rg: 30, cod_mun: 5, bu: 3, vendedor: 6, condicao: 3,
  forma_pagto: 1, cartao_autenticacao: 40, transportadora: 6, tipo_frete: 1, fat_parcial: 1, mensagem: 300
};
function lerEscolhas(corpo, proposta) {
  const b = corpo || {};
  const e = {};
  for (const [k, max] of Object.entries(CAMPOS)) e[k] = D.trim(b[k]).slice(0, max);
  for (const k of ['bu', 'tipo_frete', 'fat_parcial']) e[k] = e[k].toUpperCase();
  e.genero = D.normalizarGenero(e.genero) || '';
  e.nascimento = D.normalizarData(e.nascimento) || '';
  e.tes = {};
  for (const it of proposta.itens || []) e.tes[it.seq] = D.trim(b.tes && b.tes[it.seq]).slice(0, 3);
  return e;
}

module.exports = (app) => ({
  verb: 'post',
  route: '/adm/protheus/:uuid/lancar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const uuid = D.trim(req.params.uuid).toLowerCase();
    const simular = process.env.CIOSP_PROTHEUS_SIMULAR === '1';

    try {
      // ------------------------------------------------ 1. validação (fora de transação)
      const r0 = await Pg.connectAndQuery(`SELECT * FROM tab_ciosp_pedido WHERE uuid = @uuid`, { uuid });
      if (!r0.length) return res.status(404).json({ message: 'Pedido não encontrado.' });
      if (process.env.CIOSP_PROTHEUS_ATIVO !== '1') return res.status(409).json({ message: 'Inserção automática desligada.' });

      const proposta = await CP.carregarProposta(app, r0[0]);
      const escolhas = lerEscolhas(req.body, proposta);
      const faltas = P.faltasParaEnviar(proposta, escolhas);
      if (faltas.length) return res.status(400).json({ message: `Falta: ${faltas.join(', ')}.`, faltas });
      // Código e loja decididos pela proposta (cliente novo vai vazio), nunca pelo corpo.
      Object.assign(escolhas, P.clienteDoEnvio(proposta, escolhas));

      const usuario = D.trim(user?.EMAIL ?? user?.email).split('@')[0];
      const faixa = E.faixaDe();
      const payload = E.montarEnvio({ pedido: r0[0], itens: proposta.itens, escolhas, simular, usuario, faixa });

      // ------------------------------------------------ 2. transação curta
      const t1 = await Pg.withTransaction(async (db) => {
        await trava(db, uuid);
        const [ped] = await q(db, `SELECT * FROM tab_ciosp_pedido WHERE uuid = $1 FOR UPDATE`, [uuid]);
        if (!ped) return { status: 404, erro: 'Pedido não encontrado.' };
        if (ped.situacao !== 'conferido') {
          return { status: 409, erro: `Pedido ${F.ROTULO[ped.situacao] || ped.situacao}: só pedido conferido vai ao Protheus.` };
        }
        if (Number(ped.adm_responsavel) !== uid) return { status: 409, erro: 'Pedido com outro ADM.' };
        const pend = F.pendenciasAntesDoProtheus(ped);
        if (pend.length) return { status: 400, erro: `Falta: ${pend.join(', ')}.` };
        if (ped.protheus_envio === 'criado') return { status: 409, erro: `Pedido já está no Protheus: nº ${D.trim(ped.protheus_pedido)}.` };
        if (E.envioTravado(ped, new Date())) return { status: 409, erro: E.MENSAGEM.em_andamento };
        if (D.trim(ped.protheus_pedido)) {
          return { status: 409, erro: 'O pedido já tem nº do Protheus informado à mão: se esse pedido existe no Protheus, finalize pelo passo 4 — o botão criaria outro.' };
        }

        if (!simular) {
          await q(db,
            `UPDATE tab_ciosp_pedido
                SET protheus_envio = 'enviando', protheus_envio_em = NOW(), protheus_envio_por = $2,
                    protheus_tentativas = protheus_tentativas + 1,
                    cliente_genero = COALESCE($3, cliente_genero), cliente_nascimento = COALESCE($4::date, cliente_nascimento),
                    atualizado_em = NOW(), atualizado_por = $2
              WHERE id = $1`, [ped.id, uid, escolhas.genero || null, escolhas.nascimento || null]);
        }
        const [{ n }] = await q(db, `SELECT COUNT(*)::int + 1 AS n FROM tab_ciosp_protheus_envio WHERE pedido_id = $1`, [ped.id]);
        const [env] = await q(db,
          `INSERT INTO tab_ciosp_protheus_envio (pedido_id, tentativa, enviado_por, simulado, escolhas, payload)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [ped.id, n, uid, simular, JSON.stringify(escolhas), JSON.stringify(payload)]);
        return { pedido: ped, envioId: env.id, tentativa: n };
      });
      if (t1.erro) return res.status(t1.status).json({ message: t1.erro });
      const pedido = t1.pedido;

      // ------------------------------------------------ 3. chamada (sem trava)
      const resp = await PV.incluirPedido(payload);
      const lido = E.interpretarResposta({ ...resp, simular });
      const devolveuNumero = !simular && ['criado', 'ja_existia'].includes(lido.resultado) && !!lido.pedido;
      if (lido.resultado === 'incerto' || lido.resultado === 'sem_licenca') {
        console.warn(`ciosp/adm-protheus-lancar: pedido ${pedido.id} ${lido.resultado} (http ${resp.http}, ${resp.erro || '-'}, ${resp.duracao_ms} ms)`);
      }
      const conferido = devolveuNumero ? await F.conferirNumeroProtheus(app, lido.pedido, pedido.cliente_doc) : null;
      // Pedido do Protheus de outro CPF/CNPJ não é adotado (tentativa antiga com outro cliente).
      const adocao = devolveuNumero ? E.decidirAdocao({ resultado: lido.resultado, pedido: lido.pedido, conferido }) : null;
      const criou = devolveuNumero && adocao.adotar;
      if (adocao && !adocao.adotar) { lido.resultado = 'recusado'; lido.mensagem = adocao.mensagem; lido.inconsistencias = []; }

      // ------------------------------------------------ 4. fechamento
      const t2 = await Pg.withTransaction(async (db) => {
        await trava(db, uuid);
        await q(db, `SELECT id FROM tab_ciosp_pedido WHERE id = $1 FOR UPDATE`, [pedido.id]);
        // A linha da tentativa guarda o que o Protheus respondeu (ja_existia continua
        // ja_existia mesmo quando a intranet não adota o nº).
        const resultadoEnvio = adocao && !adocao.adotar ? E.interpretarResposta({ ...resp, simular }).resultado : lido.resultado;
        await q(db,
          `UPDATE tab_ciosp_protheus_envio SET http = $2, resposta = $3, resultado = $4, duracao_ms = $5 WHERE id = $1`,
          [t1.envioId, resp.http || null, resp.corpo ? JSON.stringify(resp.corpo) : null, resultadoEnvio, resp.duracao_ms]);
        if (simular) return {};

        if (!criou) {
          await q(db, `UPDATE tab_ciosp_pedido SET protheus_envio = $2, atualizado_em = NOW() WHERE id = $1`,
            [pedido.id, E.estadoEnvio(lido.resultado)]);
          return {};
        }

        const c = lido.cliente || {};
        await q(db,
          `UPDATE tab_ciosp_pedido
              SET protheus_envio = 'criado', protheus_pedido = $2, protheus_conferido = $3, protheus_conferido_em = NOW(),
                  cliente_cod = COALESCE(NULLIF($4, ''), cliente_cod), cliente_loja = COALESCE(NULLIF($5, ''), cliente_loja),
                  protheus_cliente_criado = protheus_cliente_criado OR $6,
                  atualizado_em = NOW(), atualizado_por = $7
            WHERE id = $1`,
          [pedido.id, lido.pedido, conferido || 'nao_conferido', D.trim(c.codigo), D.trim(c.loja), c.criado === true, uid]);

        // O nº já está gravado: se finalizar falhar, volta só até aqui.
        await q(db, 'SAVEPOINT finalizar');
        try {
          const [depois] = await q(db, `SELECT * FROM tab_ciosp_pedido WHERE id = $1`, [pedido.id]);
          const fin = F.aplicarAcao(depois, 'finalizar', {}, { usuarioId: uid, agora: new Date() });
          if (fin.erro) throw new Error(fin.erro);
          await q(db,
            `UPDATE tab_ciosp_pedido SET situacao = $2, finalizado_por = $3, finalizado_em = $4, atualizado_em = NOW(), atualizado_por = $3
              WHERE id = $1`, [pedido.id, fin.situacao, fin.campos.finalizado_por, fin.campos.finalizado_em]);
          const painel = await Painel.sincronizarPainel(db, pedido.id);
          return { finalizou: true, painel };
        } catch (e) {
          await q(db, 'ROLLBACK TO SAVEPOINT finalizar');
          return { erroFinalizar: e.message };
        }
      });

      // ------------------------------------------------ trilha e auditoria
      const num = lido.pedido;
      let aviso = criou ? adocao.aviso : null;
      if (criou) {
        await D.registrar(Pg, 'pedido', pedido.id, 'protheus', {
          de: pedido.situacao,
          para: `${num} · lançado pelo botão${lido.resultado === 'ja_existia' ? ' · já existia' : ''}${lido.cliente && lido.cliente.criado ? ' · cliente cadastrado' : ''}`,
          usuarioId: uid
        });
        if (t2.finalizou) await D.registrar(Pg, 'pedido', pedido.id, 'finalizou', { de: 'conferido', para: 'finalizado', usuarioId: uid });
        if (lido.total != null && Math.abs(lido.total - proposta.totais.itens) > 0.05) {
          aviso = [aviso, `Total divergente: Protheus R$ ${reais(lido.total)} × pedido R$ ${reais(proposta.totais.itens)}.`].filter(Boolean).join(' ');
          await D.registrar(Pg, 'pedido', pedido.id, 'protheus',
            { para: `total divergente: Protheus R$ ${reais(lido.total)} × pedido R$ ${reais(proposta.totais.itens)}`, usuarioId: uid });
        }
        if (t2.erroFinalizar) aviso = [`Pedido ${num} criado no Protheus, mas não deu para finalizar: ${t2.erroFinalizar}`, aviso].filter(Boolean).join(' ');
      } else if (!simular) {
        await D.registrar(Pg, 'pedido', pedido.id, 'protheus', {
          para: lido.resultado === 'recusado' ? `recusado: ${lido.mensagem}`.slice(0, 300) : `${lido.resultado}: ${lido.mensagem || 'sem confirmação do Protheus'}`.slice(0, 300),
          usuarioId: uid
        });
      } else if (lido.resultado === 'incerto') {
        // Simulação que voltou como pedido real (ou sem confirmação): fica na trilha.
        await D.registrar(Pg, 'pedido', pedido.id, 'protheus', { para: `simulação: ${lido.mensagem}`.slice(0, 300), usuarioId: uid });
      }
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Fila do ADM', acao: simular ? 'PROTHEUS_SIMULAR' : 'PROTHEUS_LANCAR',
        severidade: simular ? 'ALERTA' : 'CRITICO',
        req, entidade: 'pedido', entidadeId: String(pedido.id),
        descricao: `Pedido ${pedido.numero} (${pedido.cliente_nome}): ${simular ? 'simulação ' : ''}${lido.resultado}` +
          (num ? ` · nº ${num}` : '') + ` · id_externo ${payload.id_externo} · tentativa ${t1.tentativa}`
      });

      // ------------------------------------------------ resposta
      if (simular) {
        return res.json({ simulado: true, resultado: lido.resultado, total: lido.total, total_mercadoria: lido.total_mercadoria,
          inconsistencias: lido.inconsistencias, mensagem: lido.mensagem });
      }
      if (criou) {
        return res.json({
          ok: true, resultado: lido.resultado, pedido: num, cliente: lido.cliente, finalizado: !!t2.finalizou, aviso,
          venda: t2.painel && t2.painel.venda_id ? { id: t2.painel.venda_id, situacao_fin: t2.painel.situacao_fin } : null
        });
      }
      if (lido.resultado === 'recusado') return res.status(422).json({ message: lido.mensagem, inconsistencias: lido.inconsistencias });
      return res.status(504).json({ message: lido.mensagem || E.MENSAGEM.incerto });
    } catch (err) {
      console.error('ciosp/adm-protheus-lancar:', err.message);
      return res.status(500).json({ message: 'Erro ao lançar no Protheus: ' + err.message });
    }
  }
});
