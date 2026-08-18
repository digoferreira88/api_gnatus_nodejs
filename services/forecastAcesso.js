// services/forecastAcesso.js — escopo do módulo de forecast.
//   18001 = vendedor: vê/edita SÓ as carteiras onde usuario_id = ele.
//   18002 = gestão (ou admin 0): vê todas + dashboard + admin de carteiras.

async function ehGestao(Pg, userId) {
  const r = await Pg.connectAndQuery(
    `SELECT 1 FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, 18002) LIMIT 1`, { id: userId });
  return r.length > 0;
}

// Carteiras que o usuário pode VER (gestão = todas; vendedor = as dele).
async function carteirasVisiveis(Pg, userId, gestao) {
  if (gestao) {
    return Pg.connectAndQuery(
      `SELECT * FROM tab_forecast_carteira WHERE ativo ORDER BY ordem`);
  }
  return Pg.connectAndQuery(
    `SELECT * FROM tab_forecast_carteira WHERE ativo AND usuario_id = @id ORDER BY ordem`,
    { id: userId });
}

async function carteiraSePode(Pg, userId, gestao, carteiraId) {
  const rows = await Pg.connectAndQuery(
    `SELECT * FROM tab_forecast_carteira WHERE id = @c AND ativo LIMIT 1`, { c: carteiraId });
  const cart = rows[0];
  if (!cart) return { cart: null, pode: false };
  const pode = gestao || Number(cart.usuario_id) === Number(userId);
  return { cart, pode };
}

module.exports = { ehGestao, carteirasVisiveis, carteiraSePode };
