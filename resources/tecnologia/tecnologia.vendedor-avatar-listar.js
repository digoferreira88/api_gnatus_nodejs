// GET /tecnologia/vendedores-avatares
// Lista os vendedores ATIVOS da SA3 (Protheus) + flag `temAvatar` indicando
// se ha imagem cadastrada em tab_vendedor_avatar. Usado pela tela de
// gerenciamento de avatares.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/vendedores-avatares',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    try {
      // Vendedores ativos no Protheus
      const sa3 = await Protheus.connectAndQuery(`
        SELECT RTRIM(A3_COD) cod, RTRIM(A3_NOME) nome, RTRIM(A3_EMAIL) email
          FROM SA3010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
           AND A3_MSBLQL <> '1'
         ORDER BY A3_NOME`);

      // Avatares ja cadastrados (so codigo + atualizado_em — sem trazer bytes)
      let avatares = [];
      try {
        avatares = await Pg.connectAndQuery(`
          SELECT a.codigo, a.mime_type, a.tamanho_bytes, a.atualizado_em,
                 u.nome AS atualizado_por_nome
            FROM tab_vendedor_avatar a
            LEFT JOIN tab_intranet_usr u ON u.id = a.atualizado_por`);
      } catch (e) {
        console.warn('vendedores-avatares: tab_vendedor_avatar indisponivel (rodar migration 52?):', e.message);
      }

      const avatarPorCod = new Map();
      avatares.forEach(a => avatarPorCod.set(trim(a.codigo), {
        mimeType: trim(a.mime_type),
        tamanhoBytes: Number(a.tamanho_bytes || 0),
        atualizadoEm: a.atualizado_em,
        atualizadoPorNome: trim(a.atualizado_por_nome)
      }));

      const vendedores = sa3.map(v => ({
        codigo: trim(v.cod),
        nome: trim(v.nome),
        email: trim(v.email),
        avatar: avatarPorCod.get(trim(v.cod)) || null
      }));

      return res.json({
        total: vendedores.length,
        comAvatar: vendedores.filter(v => v.avatar).length,
        vendedores
      });
    } catch (err) {
      console.error('vendedores-avatares:', err);
      return res.status(500).json({ message: 'Erro ao listar vendedores: ' + err.message });
    }
  }
});
