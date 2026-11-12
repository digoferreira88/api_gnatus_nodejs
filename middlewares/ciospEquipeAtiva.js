// Middleware das rotas do CIOSP usadas pelo app do estande: quem só tem a permissão do
// app (19005) precisa estar ATIVO na equipe da edição ativa (spec §11). Equipe interna
// (19001–19004, admin) passa direto. Usar depois do requirePerm.
const F = require('../services/ciospFluxo');

module.exports = (app) => async (req, res, next) => {
  const user = req.user && req.user[0];
  try {
    const bloqueio = await F.exigeEquipeAtiva(app, user?.ID ?? user?.id);
    if (bloqueio) return res.status(403).json({ message: bloqueio });
    return next();
  } catch (err) {
    console.error('ciospEquipeAtiva:', err.message);
    return res.status(500).json({ message: 'Erro ao validar a equipe do evento.' });
  }
};
