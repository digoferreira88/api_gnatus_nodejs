// Toggle (concede/remove) uma permissão de um usuário.
module.exports = app => ({
  verb: 'post',
  route: '/permissoes/toggle',
  middlewares: [require('../../middlewares/requirePerm')(app)([1026])],  // 1026 = Gerenciamento Permissoes
  handler: async (req, res) => {
    const { Pg } = app.services;
    const { ID_USER, ID_PERMISSAO, MATRICULA, ASSIGNED } = req.body;

    const idUser = Number(ID_USER);
    const idPerm = Number(ID_PERMISSAO);
    const assigned = Number(ASSIGNED);

    // OBS: idPerm pode ser 0 (perm "Administrador acesso total"), por isso
    // não usamos `!idPerm` — usamos checagem explícita de NaN/negativo.
    if (!Number.isInteger(idUser) || idUser <= 0 ||
        !Number.isInteger(idPerm) || idPerm < 0 ||
        !MATRICULA || (assigned !== 0 && assigned !== 1)) {
      return res.status(400).json({ message: 'Parâmetros inválidos.' });
    }

    try {
      if (assigned === 1) {
        // Concede (idempotente — ON CONFLICT evita duplicata)
        await Pg.connectAndQuery(
          `INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
           VALUES (@u, @p, @m)
           ON CONFLICT (id_user, id_permissao) DO NOTHING`,
          { u: idUser, p: idPerm, m: MATRICULA }
        );
      } else {
        // Revoga
        await Pg.connectAndQuery(
          `DELETE FROM tab_intranet_usr_permissoes
            WHERE id_user = @u AND id_permissao = @p`,
          { u: idUser, p: idPerm }
        );
      }
      return res.json({
        message: 'Permissões atualizada com sucesso.',
        ID_USER: idUser, ID_PERMISSAO: idPerm, MATRICULA, ASSIGNED: assigned
      });
    } catch (error) {
      console.error('Erro toggle permissão:', error);
      return res.status(500).json({ message: error.message });
    }
  }
});
