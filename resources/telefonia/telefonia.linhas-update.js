// PUT /telefonia/linhas/:id — atualiza linha. Registra historico apenas
// dos campos que de fato mudaram (e detecta troca de titular pra acao TROCA_USUARIO).
// Permissao 1027.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v == null ? '' : v).trim();
const STATUS_VALIDOS = new Set(['Ativa', 'Suspensa', 'Cancelada', 'EmEstoque']);

const CAMPOS = [
  ['id_operadora',    'id_operadora',    (v) => v == null ? null : Number(v) || null],
  ['id_conta',        'id_conta',        (v) => v == null || v === '' ? null : Number(v)],
  ['id_departamento', 'id_departamento', (v) => v == null || v === '' ? null : Number(v)],
  ['numero_telefone', 'numero_telefone', (v) => trim(v).replace(/\D/g, '') || null],
  ['plano',           'plano',           (v) => trim(v) || null],
  ['franquia_gb',     'franquia_gb',     (v) => v == null || v === '' ? null : Number(v)],
  ['pessoa',          'pessoa',          (v) => trim(v) || null],
  ['codigo_protheus', 'codigo_protheus', (v) => trim(v) || null],
  ['filial',          'filial',          (v) => trim(v) || null],
  ['centro_custo',    'centro_custo',    (v) => trim(v) || null],
  ['data_ativacao',   'data_ativacao',   (v) => trim(v) || null],
  ['data_vencimento', 'data_vencimento', (v) => trim(v) || null],
  ['status',          'status',          (v) => STATUS_VALIDOS.has(trim(v)) ? trim(v) : null],
  ['observacoes',     'observacoes',     (v) => trim(v) || null]
];

module.exports = (app) => ({
  verb: 'put',
  route: '/linhas/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido.' });
    }

    try {
      const cur = await Pg.connectAndQuery(
        `SELECT * FROM tab_telefonia_linha WHERE id = @id`, { id }
      );
      if (!cur.length) return res.status(404).json({ message: 'Linha nao encontrada.' });
      const antes = cur[0];

      const sets = [];
      const params = { id };
      const diff = {};
      for (const [bodyKey, dbKey, conv] of CAMPOS) {
        if (!Object.prototype.hasOwnProperty.call(b, bodyKey)) continue;
        const novoVal = conv(b[bodyKey]);
        if (String(antes[dbKey] ?? '') === String(novoVal ?? '')) continue;
        sets.push(`${dbKey} = @${dbKey}`);
        params[dbKey] = novoVal;
        diff[dbKey] = { antes: antes[dbKey], depois: novoVal };
      }

      if (!sets.length) return res.json({ ok: true, alterado: false });

      sets.push(`atualizado_em = NOW()`);
      await Pg.connectAndQuery(
        `UPDATE tab_telefonia_linha SET ${sets.join(', ')} WHERE id = @id`,
        params
      );

      const trocouTitular = diff.pessoa && (antes.pessoa || '') !== (diff.pessoa.depois || '');
      const trocouStatus  = diff.status && antes.status !== diff.status.depois;
      const acao = trocouTitular ? 'TROCA_USUARIO' : (trocouStatus ? 'STATUS' : 'UPDATE');

      const desc = trocouTitular
        ? `Titular alterado: "${antes.pessoa || '-'}" → "${diff.pessoa.depois || '-'}"`
        : trocouStatus
          ? `Status alterado: ${antes.status} → ${diff.status.depois}`
          : `Atualizou ${Object.keys(diff).join(', ')}`;

      await Pg.connectAndQuery(`
        INSERT INTO tab_telefonia_linha_hist (id_linha, acao, antes, depois, id_usuario, usuario_nome, descricao)
        VALUES (@id, @acao, @bef::jsonb, @aft::jsonb, @uid, @uname, @desc)`,
        {
          id, acao,
          bef: JSON.stringify(Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.antes]))),
          aft: JSON.stringify(Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.depois]))),
          uid: user?.ID || null,
          uname: trim(user?.NOME) || null,
          desc
        }
      );

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'TelefoniaMovel',
        acao: trocouTitular ? 'TROCA_USUARIO' : 'UPDATE',
        severidade: trocouStatus && diff.status.depois === 'Cancelada' ? 'ALERTA' : 'INFO',
        req, entidade: 'telefonia_linha', entidadeId: String(id),
        descricao: `Linha ${antes.numero_telefone}: ${desc}`,
        antes: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.antes])),
        depois: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.depois]))
      });

      return res.json({ ok: true, alterado: true, campos_alterados: Object.keys(diff) });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ message: 'Numero ja cadastrado nesta operadora.' });
      }
      console.error('telefonia/linhas update:', err);
      return res.status(500).json({ message: 'Erro ao atualizar: ' + err.message });
    }
  }
});
