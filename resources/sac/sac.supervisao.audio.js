// Faz proxy do áudio da gravação Falemais.
// As gravações vêm em WAV/GSM 6.10 (codec de telefonia que browsers NÃO tocam).
// Para `modo=play` transcodamos GSM → MP3 on-the-fly via ffmpeg-static.
// Para `modo=get` devolvemos o WAV cru (usuário pode abrir em VLC/Windows Media).

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const trim = (v) => String(v || '').trim();

const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT id_permissao FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, 6002)`,
    { id: idUser }
  );
  return r.length > 0;
};

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/supervisao/audio/:uniqueid',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Falemais } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    if (!(await checarPerm(Pg, user.ID))) {
      return res.status(403).json({ message: 'Acesso negado. Permissão Supervisor SAC necessária.' });
    }

    const uniqueid = trim(req.params.uniqueid);
    if (!uniqueid) return res.status(400).json({ message: 'uniqueid obrigatório.' });

    const modo = (req.query.modo === 'get') ? 'get' : 'play';

    try {
      const url = await Falemais.downloadGravacaoUrl(uniqueid);
      const r = await fetch(url);
      if (!r.ok) {
        const txt = await r.text();
        // Falemais responde de forma inconsistente quando o áudio não existe:
        //   422 + {"status":"error","message":"Arquivo não existe"}
        //   500 + HTML com "Undefined offset" (bug do parser deles em CDRs incomuns)
        //   404 (raro)
        // Em qualquer um desses casos, tratamos como SEM_GRAVACAO no nosso lado.
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch { /* não é JSON, provável HTML */ }
        const msgLower = (parsed?.message || txt || '').toLowerCase();
        const semGravacao =
          r.status === 404 ||
          r.status === 422 ||
          r.status === 500 ||
          msgLower.includes('não existe') ||
          msgLower.includes('nao existe') ||
          msgLower.includes('undefined offset');
        if (semGravacao) {
          return res.status(404).json({
            message: 'Esta chamada não possui gravação disponível.',
            code: 'SEM_GRAVACAO',
            falemaisStatus: r.status,
            falemaisMessage: parsed?.message || (r.status === 500 ? 'Erro interno na Falemais (CDR incompatível)' : txt.slice(0, 200))
          });
        }
        return res.status(502).json({
          message: 'Falha ao buscar áudio na Falemais.',
          status: r.status, body: txt.slice(0, 300)
        });
      }
      const wavBuf = Buffer.from(await r.arrayBuffer());

      if (modo === 'get') {
        // Download cru (WAV/GSM original)
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', wavBuf.length);
        res.setHeader('Content-Disposition', `attachment; filename="gravacao_${uniqueid}.wav"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.end(wavBuf);
      }

      // modo=play: transcoda GSM → MP3 (32kbps, mono, 8kHz) via stdin/stdout do ffmpeg
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `inline; filename="gravacao_${uniqueid}.mp3"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Accept-Ranges', 'none');

      const ff = spawn(ffmpegPath, [
        '-loglevel', 'error',
        '-i', 'pipe:0',           // entrada via stdin
        '-f', 'mp3',
        '-b:a', '32k',
        '-ac', '1',
        '-ar', '8000',
        'pipe:1'                  // saída via stdout
      ]);

      ff.stdout.pipe(res);
      ff.stderr.on('data', d => console.warn('ffmpeg:', d.toString().trim()));
      ff.on('error', e => {
        console.error('ffmpeg spawn err:', e.message);
        if (!res.headersSent) res.status(500).json({ message: 'Erro de transcoding: ' + e.message });
        else res.end();
      });
      ff.on('close', code => {
        if (code !== 0) console.warn('ffmpeg exited with code', code);
      });

      ff.stdin.write(wavBuf);
      ff.stdin.end();
    } catch (err) {
      console.error('Erro audio:', err);
      if (!res.headersSent) {
        return res.status(500).json({ message: 'Erro ao baixar áudio: ' + err.message });
      }
    }
  }
});
