// GET /integracao/op-produtos-lista — endpoint de MAQUINA para a automacao
// OP -> Pipedrive (roda numa maquina local) buscar a lista de produtos
// monitorados, em vez de mante-la hardcoded no script.
//
// SEM JWT (anonymous): autentica por token estatico do .env
// (INTEGRACAO_OP_TOKEN), enviado de preferencia no header
// "x-integracao-token" (querystring ?token= tambem aceita p/ clientes
// limitados, ciente de que vaza em log de acesso).
//
// Formatos:
//   (default)    -> { codigos: ["001","002"], total, geradoEm }
//   ?format=in   -> texto puro: '001','002'   (p/ colar direto num IN SQL)
//   ?format=csv  -> texto puro: 001,002

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/op-produtos-lista',
  anonymous: true,           // pula o JWT global — auth por token de maquina

  handler: async (req, res) => {
    const { Pg } = app.services;
    const esperado = trim(process.env.INTEGRACAO_OP_TOKEN);
    const recebido = trim(req.headers['x-integracao-token']) || trim(req.query.token);

    if (!esperado) return res.status(503).json({ message: 'INTEGRACAO_OP_TOKEN não configurado no servidor.' });
    if (!recebido || recebido !== esperado) return res.status(401).json({ message: 'Token inválido.' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT codigo FROM tab_op_pipedrive_produtos WHERE ativo = true ORDER BY codigo`, {});
      const codigos = rows.map(r => trim(r.codigo));
      const format = trim(req.query.format).toLowerCase();

      if (format === 'in') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(codigos.map(c => `'${c.replace(/'/g, "''")}'`).join(','));
      }
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(codigos.join(','));
      }
      return res.json({ codigos, total: codigos.length, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('Erro op-produtos-publico:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
