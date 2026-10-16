// GET /tecnologia/vendedor-avatar/:codigo
// Serve a imagem (bytea) com cache headers. ENDPOINT ANONIMO — o <img src=...>
// nao manda Authorization. Conteudo eh foto profissional do vendedor; baixa
// sensibilidade. Cache com revalidacao por ETag: troca de foto aparece na hora.

const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/vendedor-avatar/:codigo',
  anonymous: true,   // bypassa o middleware de authentication global

  handler: async (req, res) => {
    const { Pg } = app.services;
    const codigo = trim(req.params.codigo);
    if (!codigo) return res.status(400).end();

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT mime_type, bytes, atualizado_em
          FROM tab_vendedor_avatar
         WHERE codigo = @cod`, { cod: codigo });

      if (!rows.length) {
        // 404 sem corpo — o front decide o fallback (iniciais coloridas)
        return res.status(404).end();
      }
      const r = rows[0];
      // ETag derivado do timestamp pra invalidar cache automaticamente ao re-upar
      const etag = `"${new Date(r.atualizado_em).getTime()}-${codigo}"`;

      // 304 Not Modified se o browser ja tem essa versao
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.setHeader('Content-Type', trim(r.mime_type) || 'image/webp');
      // no-cache = o navegador guarda, mas confere o ETag a cada uso (304 barato).
      // Com max-age=86400 a foto trocada so aparecia no ranking no dia seguinte.
      res.setHeader('Cache-Control', 'public, no-cache');
      res.setHeader('ETag', etag);
      return res.end(r.bytes);
    } catch (err) {
      console.error('vendedor-avatar-get:', err);
      return res.status(500).end();
    }
  }
});
