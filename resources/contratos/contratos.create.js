// POST /contratos — cria contrato
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const Contratos = require('../../services/contratos');
const Auditoria = require('../../services/auditoria');

const trim = (v) => v == null ? null : String(v).trim() || null;
const toN  = (v) => (v == null || v === '') ? null : Number(v);
const toDate = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v)) ? v.slice(0, 10) : null;

module.exports = (app) => ({
  verb: 'post',
  route: '/',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    const tipo = trim(b.tipo);
    if (!Contratos.TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ message: 'tipo invalido. Use ' + Contratos.TIPOS_VALIDOS.join('/') });
    }
    if (!trim(b.titulo)) return res.status(400).json({ message: 'titulo obrigatorio.' });
    if (!trim(b.contraparte_nome)) return res.status(400).json({ message: 'contraparte_nome obrigatorio.' });

    try {
      const numero = trim(b.numero) || await Contratos.proximoNumero(Pg);

      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_contrato (
          numero, tipo, titulo, descricao,
          contraparte_tipo, contraparte_cod, contraparte_loja, contraparte_nome,
          contraparte_cnpj, contraparte_email, contraparte_tel, contraparte_endereco,
          id_user_responsavel, responsavel_nome, responsavel_email, responsavel_departamento,
          vigencia_inicio, vigencia_fim,
          valor_total, valor_mensal, moeda,
          indice_reajuste, mes_aniversario_reajuste, dia_vencimento_mensal,
          renovacao_automatica, prazo_renovacao_meses,
          meta, observacoes,
          id_user_criou, id_user_atualizou
        ) VALUES (
          @numero, @tipo, @titulo, @descricao,
          @ctp_tipo, @ctp_cod, @ctp_loja, @ctp_nome,
          @ctp_cnpj, @ctp_email, @ctp_tel, @ctp_end,
          @resp_id, @resp_nome, @resp_email, @resp_dep,
          @vig_ini::date, @vig_fim::date,
          @vt, @vm, @moeda,
          @idx, @mes_aniv, @dia_venc,
          @ren_auto, @ren_meses,
          @meta::jsonb, @obs,
          @uid, @uid
        ) RETURNING id, numero`,
        {
          numero, tipo, titulo: trim(b.titulo), descricao: trim(b.descricao),
          ctp_tipo: trim(b.contraparte_tipo) || 'OUTRO',
          ctp_cod: trim(b.contraparte_cod), ctp_loja: trim(b.contraparte_loja),
          ctp_nome: trim(b.contraparte_nome), ctp_cnpj: trim(b.contraparte_cnpj),
          ctp_email: trim(b.contraparte_email), ctp_tel: trim(b.contraparte_tel),
          ctp_end: trim(b.contraparte_endereco),
          resp_id: b.id_user_responsavel ? Number(b.id_user_responsavel) : null,
          resp_nome: trim(b.responsavel_nome),
          resp_email: trim(b.responsavel_email),
          resp_dep: trim(b.responsavel_departamento),
          vig_ini: toDate(b.vigencia_inicio), vig_fim: toDate(b.vigencia_fim),
          vt: toN(b.valor_total), vm: toN(b.valor_mensal),
          moeda: trim(b.moeda) || 'BRL',
          idx: trim(b.indice_reajuste),
          mes_aniv: toN(b.mes_aniversario_reajuste),
          dia_venc: toN(b.dia_vencimento_mensal),
          ren_auto: !!b.renovacao_automatica,
          ren_meses: toN(b.prazo_renovacao_meses),
          meta: b.meta ? JSON.stringify(b.meta) : null,
          obs: trim(b.observacoes),
          uid: user?.ID || null
        }
      );

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'CREATE', severidade: 'INFO',
        req, entidade: 'contrato', entidadeId: String(r[0].id),
        descricao: `Criou contrato ${r[0].numero} — ${trim(b.titulo)}`,
        meta: { id: r[0].id, numero: r[0].numero, tipo, contraparte: trim(b.contraparte_nome) }
      });

      return res.json({ ok: true, id: r[0].id, numero: r[0].numero });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: 'Numero ja existe: ' + err.detail });
      console.error('contratos/create:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
