// Certificado de conclusao do curso. GET /universidade/curso/:id/certificado[?userId=N]
// - Sem ?userId: certificado do user logado (precisa estar matriculado e concluido).
// - Com ?userId: instrutor/admin emite pra outro user (so dono do curso ou admin 15003).
// Retorna HTML printable (browser converte pra PDF via Ctrl+P).

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const { ehInstrutor, ehAdmin } = require('./_perms');

module.exports = (app) => ({
  verb: 'get',
  route: '/curso/:id/certificado',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).send('Nao autenticado.');

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('ID invalido.');

    // Quem é o ALVO do certificado: por default eh o user logado.
    // Se vier ?userId=X, exige perm de instrutor (dono do curso) ou admin.
    let targetUserId = Number(user.ID);
    const queryUserId = req.query.userId != null ? Number(req.query.userId) : null;
    if (queryUserId && queryUserId !== Number(user.ID)) {
      // Precisa ser instrutor com acesso ao curso ou admin universal
      const cursoCheck = await Pg.connectAndQuery(
        `SELECT instrutor_id FROM tab_uni_curso WHERE id = @id`, { id }
      );
      if (!cursoCheck.length) return res.status(404).send('Curso nao encontrado.');
      const isOwner = Number(cursoCheck[0].instrutor_id) === Number(user.ID);
      const isAdmin = await ehAdmin(Pg, user.ID);
      const isInstrutor = await ehInstrutor(Pg, user.ID);
      if (!(isOwner || isAdmin) || !isInstrutor) {
        return res.status(403).send('Sem permissao para emitir certificado de outro usuario.');
      }
      targetUserId = queryUserId;
    }

    try {
      const r = await Pg.connectAndQuery(`
        SELECT c.titulo, c.codigo, c.carga_horaria_h, c.instrutor_nome,
               m.data_conclusao, m.status, m.id AS matricula_id,
               u.nome AS user_nome, u.email AS user_email,
               cat.nome AS categoria_nome
          FROM tab_uni_matricula m
          INNER JOIN tab_uni_curso c     ON c.id = m.curso_id
          INNER JOIN tab_intranet_usr u  ON u.id = m.user_id
          LEFT  JOIN tab_uni_categoria cat ON cat.id = c.categoria_id
         WHERE m.user_id = @uid AND m.curso_id = @id`,
        { uid: targetUserId, id }
      );
      if (!r.length) return res.status(404).send('Matricula nao encontrada para este usuario.');
      if (r[0].status === 'cancelado' || !r[0].data_conclusao) {
        return res.status(409).send('Curso ainda nao foi concluido por este usuario.');
      }

      const d = r[0];
      const dataConc = new Date(d.data_conclusao).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
      const codCert = `UNI-${id}-${d.matricula_id}-${targetUserId}`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderCertificado({
        nome: esc(d.user_nome || d.user_email || ''),
        cursoTitulo: esc(d.titulo),
        cursoCodigo: esc(d.codigo),
        categoria: esc(d.categoria_nome || ''),
        cargaHoraria: Number(d.carga_horaria_h || 0),
        instrutor: esc(d.instrutor_nome || ''),
        dataConclusao: dataConc,
        codCertificado: codCert
      }));
    } catch (err) {
      console.error('Erro universidade/certificado:', err);
      return res.status(500).send('Erro: ' + err.message);
    }
  }
});

function renderCertificado(d) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Certificado — ${d.cursoTitulo}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Georgia', 'Times New Roman', serif; }
  body { background: #eef0f3; padding: 16px; }
  .toolbar { max-width: 1100px; margin: 0 auto 12px auto; display: flex; justify-content: flex-end; gap: 8px; }
  .toolbar button { padding: 10px 22px; background: #1a3f82; color: #fff; border: 0; border-radius: 8px; cursor: pointer; font-weight: 700; font-family: Arial; font-size: 13px; }
  .toolbar button:hover { background: #1e5fb5; }

  .cert {
    max-width: 1100px; margin: 0 auto; background: #fff;
    border: 8px double #1a3f82;
    box-shadow: 0 8px 30px rgba(0,0,0,0.18);
    padding: 60px 80px;
    position: relative;
    aspect-ratio: 1.414 / 1;
  }
  .cert::before, .cert::after {
    content: ''; position: absolute; width: 70px; height: 70px;
    border: 3px solid #1a3f82; border-radius: 50%;
  }
  .cert::before { top: 25px; left: 25px; border-right: 0; border-bottom: 0; border-radius: 0; }
  .cert::after  { bottom: 25px; right: 25px; border-left: 0; border-top: 0; border-radius: 0; }

  .cert-header { text-align: center; margin-bottom: 30px; }
  .cert-emp { color: #1a3f82; font-size: 14px; letter-spacing: 6px; font-weight: 700; font-family: Arial; }
  .cert-emp-sub { color: #6b7a90; font-size: 11px; margin-top: 4px; font-family: Arial; }
  .cert-titulo {
    color: #1a3f82; font-size: 56px; font-weight: 700; margin-top: 20px;
    letter-spacing: 4px; text-transform: uppercase;
  }
  .cert-subtitulo { color: #6b7a90; font-size: 14px; margin-top: 4px; letter-spacing: 8px; text-transform: uppercase; font-family: Arial; }

  .cert-body { text-align: center; margin: 50px 0 30px 0; }
  .cert-body p { color: #1a2740; font-size: 16px; line-height: 1.6; }
  .cert-nome {
    color: #1a3f82; font-size: 36px; font-weight: 700; margin: 20px 0;
    border-bottom: 1px solid #d5deec; padding-bottom: 16px; display: inline-block; min-width: 60%;
  }
  .cert-curso {
    color: #1a3f82; font-size: 22px; font-weight: 700; margin: 16px 0; font-style: italic;
  }

  .cert-detalhes {
    display: flex; justify-content: space-around; margin: 30px 0;
    padding: 20px; background: #f8fbff; border-radius: 8px;
  }
  .cert-detalhes div { text-align: center; }
  .cert-detalhes .label { font-size: 10px; color: #6b7a90; text-transform: uppercase; letter-spacing: 2px; font-family: Arial; font-weight: 700; }
  .cert-detalhes .v { font-size: 16px; color: #1a2740; font-weight: 700; margin-top: 6px; font-family: Arial; }

  .cert-footer {
    position: absolute; bottom: 60px; left: 80px; right: 80px;
    display: flex; justify-content: space-between; align-items: flex-end;
  }
  .cert-assinatura { text-align: center; flex: 1; }
  .cert-assinatura .linha { border-top: 1px solid #1a2740; width: 220px; margin: 0 auto 6px auto; }
  .cert-assinatura .nome { font-size: 13px; color: #1a2740; font-weight: 700; font-family: Arial; }
  .cert-assinatura .cargo { font-size: 11px; color: #6b7a90; font-family: Arial; }

  .cert-meta {
    text-align: right; font-size: 9px; color: #8093ac; font-family: Arial;
    line-height: 1.5;
  }

  @media print {
    body { background: #fff; padding: 0; }
    .cert { box-shadow: none; max-width: 100%; }
    .toolbar { display: none; }
    @page { size: A4 landscape; margin: 0; }
  }
</style>
</head>
<body>

<div class="toolbar">
  <button onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
</div>

<div class="cert">
  <div class="cert-header">
    <div class="cert-emp">UNIVERSIDADE GNATUS</div>
    <div class="cert-emp-sub">Plataforma interna de treinamento e desenvolvimento</div>
    <div class="cert-titulo">Certificado</div>
    <div class="cert-subtitulo">de conclusão</div>
  </div>

  <div class="cert-body">
    <p>Certificamos que</p>
    <div class="cert-nome">${d.nome}</div>
    <p>concluiu com aproveitamento o curso</p>
    <div class="cert-curso">"${d.cursoTitulo}"</div>
  </div>

  <div class="cert-detalhes">
    <div>
      <div class="label">Carga Horária</div>
      <div class="v">${d.cargaHoraria}h</div>
    </div>
    ${d.categoria ? `<div><div class="label">Categoria</div><div class="v">${d.categoria}</div></div>` : ''}
    <div>
      <div class="label">Concluído em</div>
      <div class="v">${d.dataConclusao}</div>
    </div>
    <div>
      <div class="label">Código do Curso</div>
      <div class="v">${d.cursoCodigo}</div>
    </div>
  </div>

  <div class="cert-footer">
    <div class="cert-assinatura">
      <div class="linha"></div>
      <div class="nome">${d.instrutor || 'Universidade Gnatus'}</div>
      <div class="cargo">Instrutor responsável</div>
    </div>
    <div class="cert-meta">
      Certificado nº ${d.codCertificado}<br>
      Emitido em ${new Date().toLocaleDateString('pt-BR')}<br>
      Validação interna · Intranet GNATUS
    </div>
  </div>
</div>

</body>
</html>`;
}
