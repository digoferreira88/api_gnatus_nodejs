// Helpers de permissao do modulo Universidade.
// 15001 = Aluno · 15002 = Instrutor · 15003 = Admin · 15004 = RH (gestão do módulo: cursos e avaliações)
// Admin (perm 0) sempre passa.

async function temPerm(Pg, idUser, perms) {
  const lista = Array.isArray(perms) ? perms : [perms];
  const placeholders = lista.map((_, i) => `@p${i}`).join(',');
  const params = { id: idUser };
  lista.forEach((p, i) => { params[`p${i}`] = p; });
  const r = await Pg.connectAndQuery(
    `SELECT 1 FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, ${placeholders}) LIMIT 1`,
    params
  );
  return r.length > 0;
}

const ehAluno     = (Pg, id) => temPerm(Pg, id, [15001, 15002, 15003]);
const ehInstrutor = (Pg, id) => temPerm(Pg, id, [15002, 15003, 15004]);
const ehAdmin     = (Pg, id) => temPerm(Pg, id, [15003, 15004]);

module.exports = { temPerm, ehAluno, ehInstrutor, ehAdmin };
