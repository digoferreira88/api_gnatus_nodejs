const bcrypt = require('bcryptjs');

module.exports = (app) => ({
  verb: 'post',
  route: '/:id/update',
  // 1028 = Gestao Usuarios. allowSelf permite usuario editar o proprio cadastro.
  middlewares: [require('../../middlewares/requirePerm')(app)([1028], { allowSelf: 'id' })],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ message: 'ID inválido.' });

    const { nome, email, senha, matricula, ativo, codigoProtheus, ramal } = req.body || {};
    if (!nome || !email || !matricula) {
      return res.status(400).json({ message: 'Nome, email e matrícula são obrigatórios.' });
    }

    const codProth = String(codigoProtheus || '').trim();
    if (codProth) {
      try {
        const v = await Protheus.connectAndQuery(
          `SELECT TOP 1 USR_ID FROM SYS_USR WHERE USR_ID = @cod`,
          { cod: codProth }
        );
        if (!v.length) return res.status(400).json({ message: `Código Protheus '${codProth}' não encontrado em SYS_USR.` });
      } catch (e) { console.warn('Não foi possível validar código Protheus:', e.message); }
    }

    try {
      const duplicado = await Pg.connectAndQuery(
        `SELECT ID FROM tab_intranet_usr WHERE EMAIL = @email AND ID <> @id`,
        { email, id }
      );
      if (duplicado.length > 0) {
        return res.status(409).json({ message: 'Já existe outro usuário com este e-mail.' });
      }

      const ativoFlag = ativo === false ? false : true;
      const ramalTrim = String(ramal || '').trim().slice(0, 8) || null;

      if (senha && String(senha).length >= 6) {
        const senhaHash = bcrypt.hashSync(String(senha), 10);
        await Pg.connectAndQuery(
          `UPDATE tab_intranet_usr
           SET NOME = @nome, EMAIL = @email, SENHA = @senha, MATRICULA = @matricula, ATIVO = @ativo, CODIGO_PROTHEUS = @codProth, RAMAL = @ramal
           WHERE ID = @id`,
          { id, nome, email, senha: senhaHash, matricula, ativo: ativoFlag, codProth: codProth || null, ramal: ramalTrim }
        );
      } else {
        await Pg.connectAndQuery(
          `UPDATE tab_intranet_usr
           SET NOME = @nome, EMAIL = @email, MATRICULA = @matricula, ATIVO = @ativo, CODIGO_PROTHEUS = @codProth, RAMAL = @ramal
           WHERE ID = @id`,
          { id, nome, email, matricula, ativo: ativoFlag, codProth: codProth || null, ramal: ramalTrim }
        );
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro ao atualizar usuário:', err);
      return res.status(500).json({ message: 'Erro ao atualizar usuário.' });
    }
  }
});
