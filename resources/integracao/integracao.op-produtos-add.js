// POST /integracao/op-produtos { codigo }
// Adiciona um produto a lista monitorada pela automacao OP -> Pipedrive.
// Valida o codigo no SB1 (precisa existir) e guarda a descricao. Perm 1033.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/op-produtos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const codigo = trim(req.body?.codigo).toUpperCase();
    if (!codigo) return res.status(400).json({ message: 'Informe o código do produto.' });

    try {
      // Valida no Protheus (evita digitar codigo inexistente e a automacao "nao rodar")
      const sb1 = await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(B1_COD) cod, RTRIM(B1_DESC) descricao FROM SB1010 WITH (NOLOCK)
          WHERE RTRIM(B1_COD) = @cod AND D_E_L_E_T_ <> '*'`, { cod: codigo });
      if (!sb1.length) {
        return res.status(404).json({ message: `Produto ${codigo} não encontrado no Protheus (SB1).` });
      }
      const descricao = trim(sb1[0].descricao);

      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_op_pipedrive_produtos (codigo, descricao, criado_por, criado_nome)
         VALUES (@cod, @desc, @uid, @unome)
         ON CONFLICT (codigo) DO UPDATE SET ativo = true, descricao = EXCLUDED.descricao
         RETURNING id`,
        { cod: codigo, desc: descricao, uid: user?.ID || null, unome: trim(user?.NOME) });

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'IntegracaoOpPipedrive', acao: 'ADD_PRODUTO',
        severidade: 'ALERTA', req, entidade: 'produto', entidadeId: codigo,
        descricao: `Adicionou produto ${codigo} (${descricao}) à automação OP → Pipedrive`,
        meta: { codigo, descricao }
      });
      return res.json({ ok: true, id: ins[0].id, codigo, descricao });
    } catch (err) {
      console.error('Erro op-produtos-add:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
