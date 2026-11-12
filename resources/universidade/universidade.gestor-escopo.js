// GET /universidade/gestor/escopo — o usuário logado é gestor de algum setor?
// Gestor = responsável (ou 2º responsável) do departamento no Protheus (SQB010), incluindo
// os setores abaixo na hierarquia. Usado pelo menu p/ mostrar "Minha Equipe" só p/ gestores.
// Qualquer usuário autenticado.

const { usuario, colaboradorDoUsuario, setoresDoGestor } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/gestor/escopo',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const col = await colaboradorDoUsuario(Pg, usuario(req));
    if (!col || !col.ativo) return res.json({ gestor: false, setores: [], pessoas: 0 });
    const setores = await setoresDoGestor(Pg, col.cpf);
    return res.json({
      gestor: setores.length > 0,
      setores: setores.map(s => ({ codigo: s.codigo, descricao: s.descricao, nivel: s.nivel, pessoas: s.pessoas })),
      pessoas: setores.reduce((a, s) => a + s.pessoas, 0)
    });
  }
});
