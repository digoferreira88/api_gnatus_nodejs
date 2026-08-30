// POST /users/password — troca de senha do PRÓPRIO usuário logado.
// Body: { SENHA_ATUAL, SENHA } (aceita também senhaAtual/senha).
//
// Hardening 30/08/2026 (auditoria de segurança):
//   - exige a SENHA ATUAL — um JWT roubado não vira takeover permanente da conta
//   - regra de força (mesma do formulário: mín. 8 chars, letra e número)
//   - grava por ID (antes era WHERE MATRICULA — matrícula duplicada/nula
//     alteraria a senha de vários usuários)
//   - custo bcrypt 12 nos hashes novos (compare continua aceitando os antigos)
//   - não devolve o objeto de erro cru; tentativas com senha atual errada
//     ficam na auditoria

const bcrypt = require('bcryptjs');
const Auditoria = require('../../services/auditoria');
const s = (v) => (v == null ? '' : String(v));
const ehSenhaForte = (p) => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

module.exports = (app) => ({
  verb: 'post',
  route: '/password',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const senhaAtual = s(req.body?.SENHA_ATUAL ?? req.body?.senhaAtual);
    const novaSenha = s(req.body?.SENHA ?? req.body?.senha);
    if (!senhaAtual) return res.status(400).json({ message: 'Informe a senha atual.' });
    if (!ehSenhaForte(novaSenha)) {
      return res.status(400).json({ message: 'A nova senha precisa ter ao menos 8 caracteres, com letras e números.' });
    }
    if (novaSenha === senhaAtual) return res.status(400).json({ message: 'A nova senha deve ser diferente da atual.' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT senha FROM tab_intranet_usr WHERE id = @id AND ativo = true`, { id: user.ID });
      const hash = rows[0] ? (rows[0].senha ?? rows[0].SENHA) : null;
      if (!hash || !bcrypt.compareSync(senhaAtual, String(hash))) {
        Auditoria.registrar(app, {
          modulo: 'Usuarios', submodulo: 'Senha', acao: 'SENHA_ATUAL_INVALIDA', severidade: 'ALERTA', req,
          entidade: 'usuario', entidadeId: String(user.ID),
          descricao: `Troca de senha recusada: senha atual incorreta (${s(user.EMAIL)})`
        });
        return res.status(403).json({ message: 'Senha atual incorreta.' });
      }

      await Pg.connectAndQuery(
        `UPDATE tab_intranet_usr SET senha = @senha WHERE id = @id`,
        { senha: bcrypt.hashSync(novaSenha, 12), id: user.ID });

      Auditoria.registrar(app, {
        modulo: 'Usuarios', submodulo: 'Senha', acao: 'SENHA_ALTERADA', severidade: 'INFO', req,
        entidade: 'usuario', entidadeId: String(user.ID),
        descricao: `Senha alterada pelo próprio usuário (${s(user.EMAIL)})`
      });
      return res.json({ message: 'Senha alterada com sucesso.' });
    } catch (err) {
      console.error('users/password:', err);
      return res.status(500).json({ message: 'Não foi possível alterar a senha agora. Tente novamente.' });
    }
  }
});
