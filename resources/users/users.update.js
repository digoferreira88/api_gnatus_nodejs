// POST /users/:id/update
//
// Modo admin (perm 1028): pode alterar todos os campos.
// Modo self (allowSelf): usuario edita o proprio cadastro mas NAO pode alterar
//   email, codigo_protheus, matricula nem ativo — esses campos sao
//   sensiveis (impersonation de aprovador Protheus, takeover via reset etc).
//   Self pode mudar nome, senha e ramal.

const bcrypt = require('bcryptjs');

const SENHA_MIN = 10;
const ehSenhaForte = (s) => typeof s === 'string' && s.length >= SENHA_MIN && /[A-Za-z]/.test(s) && /\d/.test(s);

module.exports = (app) => ({
  verb: 'post',
  route: '/:id/update',
  middlewares: [require('../../middlewares/requirePerm')(app)([1028], { allowSelf: 'id' })],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ message: 'ID invalido.' });

    const reqUser = req.user && req.user[0];
    if (!reqUser) return res.status(401).json({ message: 'Nao autenticado.' });

    // Verifica se eh admin (perm 1028 ou 0) — define se pode mexer em campos sensiveis
    const admCheck = await Pg.connectAndQuery(
      `SELECT 1 FROM tab_intranet_usr_permissoes
        WHERE id_user = @id AND id_permissao IN (0, 1028) LIMIT 1`,
      { id: reqUser.ID }
    );
    const isAdmin = admCheck.length > 0;
    const isSelf = Number(reqUser.ID) === id;

    if (!isAdmin && !isSelf) {
      // requirePerm ja teria barrado, mas defesa em profundidade
      return res.status(403).json({ message: 'Sem permissao.' });
    }

    const { nome, email, senha, matricula, ativo, codigoProtheus, ramal } = req.body || {};
    if (!nome) return res.status(400).json({ message: 'Nome eh obrigatorio.' });

    // === Modo self (nao-admin editando proprio cadastro) ===
    // Carrega o registro atual pra preservar os campos sensiveis.
    let emailFinal = email;
    let matriculaFinal = matricula;
    let ativoFinal = ativo;
    let codProthFinal = codigoProtheus;

    if (!isAdmin) {
      const atual = await Pg.connectAndQuery(
        `SELECT email, matricula, ativo, codigo_protheus FROM tab_intranet_usr WHERE id = @id`,
        { id }
      );
      if (!atual.length) return res.status(404).json({ message: 'Usuario nao encontrado.' });
      // Forca valores atuais — ignora qualquer tentativa de alteracao via body
      emailFinal      = atual[0].email;
      matriculaFinal  = atual[0].matricula;
      ativoFinal      = atual[0].ativo;
      codProthFinal   = atual[0].codigo_protheus;
    }

    if (!emailFinal || !matriculaFinal) {
      return res.status(400).json({ message: 'Email e matricula sao obrigatorios.' });
    }

    const codProth = String(codProthFinal || '').trim();
    if (codProth && isAdmin) {
      // Valida codigo Protheus so pra admin (self preserva o valor existente)
      try {
        const v = await Protheus.connectAndQuery(
          `SELECT TOP 1 USR_ID FROM SYS_USR WHERE USR_ID = @cod`,
          { cod: codProth }
        );
        if (!v.length) return res.status(400).json({ message: `Codigo Protheus '${codProth}' nao encontrado em SYS_USR.` });
      } catch (e) { console.warn('Nao foi possivel validar codigo Protheus:', e.message); }
    }

    if (senha != null && senha !== '' && !ehSenhaForte(senha)) {
      return res.status(400).json({
        message: `Senha fraca: minimo ${SENHA_MIN} caracteres com letras e numeros.`
      });
    }

    try {
      const duplicado = await Pg.connectAndQuery(
        `SELECT id FROM tab_intranet_usr WHERE LOWER(email) = LOWER(@email) AND id <> @id`,
        { email: emailFinal, id }
      );
      if (duplicado.length > 0) {
        return res.status(409).json({ message: 'Ja existe outro usuario com este e-mail.' });
      }

      const ativoFlag = ativoFinal === false ? false : true;
      const ramalTrim = String(ramal || '').trim().slice(0, 8) || null;

      if (ehSenhaForte(senha)) {
        const senhaHash = bcrypt.hashSync(String(senha), 10);
        await Pg.connectAndQuery(
          `UPDATE tab_intranet_usr
              SET nome = @nome, email = @email, senha = @senha, matricula = @matricula,
                  ativo = @ativo, codigo_protheus = @codProth, ramal = @ramal
            WHERE id = @id`,
          { id, nome, email: emailFinal, senha: senhaHash, matricula: matriculaFinal,
            ativo: ativoFlag, codProth: codProth || null, ramal: ramalTrim }
        );
      } else {
        await Pg.connectAndQuery(
          `UPDATE tab_intranet_usr
              SET nome = @nome, email = @email, matricula = @matricula,
                  ativo = @ativo, codigo_protheus = @codProth, ramal = @ramal
            WHERE id = @id`,
          { id, nome, email: emailFinal, matricula: matriculaFinal,
            ativo: ativoFlag, codProth: codProth || null, ramal: ramalTrim }
        );
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro ao atualizar usuario:', err.message);
      return res.status(500).json({ message: 'Erro ao atualizar usuario.' });
    }
  }
});
