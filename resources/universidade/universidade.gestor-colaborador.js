// GET /universidade/gestor/colaborador/:id — ficha de treinamento de um colaborador da
// equipe do gestor (só leitura). 403 se a pessoa não está nos setores do gestor.
// Não devolve CPF nem dados de folha.

const { usuario, colaboradorDoUsuario, setoresDoGestor } = require('./_rh');
const { fichaColaborador } = require('./universidade.rh-colaborador');

module.exports = (app) => ({
  verb: 'get',
  route: '/gestor/colaborador/:id',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID inválido.' });

    const eu = await colaboradorDoUsuario(Pg, usuario(req));
    const setores = eu && eu.ativo ? await setoresDoGestor(Pg, eu.cpf) : [];
    if (!setores.length) return res.status(403).json({ message: 'Você não é gestor de nenhum setor.' });

    const alvo = await Pg.connectAndQuery(`SELECT depto_codigo FROM tab_uni_colaborador WHERE id = @id`, { id });
    if (!alvo.length) return res.status(404).json({ message: 'Colaborador não encontrado.' });
    if (!setores.some(s => s.codigo === alvo[0].depto_codigo)) {
      return res.status(403).json({ message: 'Este colaborador não é da sua equipe.' });
    }

    const ficha = await fichaColaborador(Pg, id);
    if (!ficha) return res.status(404).json({ message: 'Colaborador não encontrado.' });
    const { cpf, centroCusto, situacaoFolha, sincronizadoEm, ...colab } = ficha.colaborador;
    return res.json({ ...ficha, colaborador: colab });
  }
});
