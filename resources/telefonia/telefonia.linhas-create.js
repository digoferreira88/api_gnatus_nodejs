// POST /telefonia/linhas — cria nova linha.
// Body: { id_operadora, id_conta?, id_departamento?, numero_telefone, plano?, franquia_gb?,
//         pessoa?, codigo_protheus?, filial?, centro_custo?, data_ativacao?, data_vencimento?,
//         status?, observacoes? }
// Permissao 1027.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v == null ? '' : v).trim();
const STATUS_VALIDOS = new Set(['Ativa', 'Suspensa', 'Cancelada', 'EmEstoque']);

module.exports = (app) => ({
  verb: 'post',
  route: '/linhas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    const idOperadora    = Number(b.id_operadora) || 0;
    const numero         = trim(b.numero_telefone).replace(/\D/g, '');
    if (!idOperadora) return res.status(400).json({ message: 'id_operadora obrigatorio.' });
    if (!numero)      return res.status(400).json({ message: 'numero_telefone obrigatorio.' });

    const status = STATUS_VALIDOS.has(trim(b.status)) ? trim(b.status) : 'Ativa';

    try {
      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_telefonia_linha (
          id_operadora, id_conta, id_departamento, numero_telefone,
          plano, franquia_gb, valor_mensal, pessoa, codigo_protheus, filial, centro_custo,
          data_ativacao, data_vencimento, status, observacoes
        ) VALUES (
          @op, @con, @dep, @num,
          @pl, @gb, @val, @pes, @cprot, @fil, @cc,
          @at, @ven, @st, @obs
        ) RETURNING id`,
        {
          op: idOperadora,
          con: b.id_conta ? Number(b.id_conta) : null,
          dep: b.id_departamento ? Number(b.id_departamento) : null,
          num: numero,
          pl: trim(b.plano) || null,
          gb: b.franquia_gb != null && b.franquia_gb !== '' ? Number(b.franquia_gb) : null,
          val: b.valor_mensal != null && b.valor_mensal !== '' ? Number(b.valor_mensal) : null,
          pes: trim(b.pessoa) || null,
          cprot: trim(b.codigo_protheus) || null,
          fil: trim(b.filial) || null,
          cc: trim(b.centro_custo) || null,
          at: trim(b.data_ativacao) || null,
          ven: trim(b.data_vencimento) || null,
          st: status,
          obs: trim(b.observacoes) || null
        }
      );
      const id = r[0].id;

      await Pg.connectAndQuery(`
        INSERT INTO tab_telefonia_linha_hist (id_linha, acao, depois, id_usuario, usuario_nome, descricao)
        VALUES (@id, 'CREATE', @after::jsonb, @uid, @uname, @desc)`,
        {
          id,
          after: JSON.stringify({ numero_telefone: numero, plano: b.plano, pessoa: b.pessoa, status }),
          uid: user?.ID || null,
          uname: trim(user?.NOME) || null,
          desc: `Linha ${numero} criada${b.pessoa ? ' para ' + b.pessoa : ''}`
        }
      );

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'TelefoniaMovel',
        acao: 'CREATE', severidade: 'INFO',
        req, entidade: 'telefonia_linha', entidadeId: String(id),
        descricao: `Cadastrou linha ${numero}${b.pessoa ? ' para ' + b.pessoa : ''}`,
        meta: { id, numero, status, plano: b.plano, pessoa: b.pessoa }
      });

      return res.json({ ok: true, id });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ message: `Numero ${numero} ja cadastrado nesta operadora.` });
      }
      console.error('telefonia/linhas create:', err);
      return res.status(500).json({ message: 'Erro ao criar linha: ' + err.message });
    }
  }
});
