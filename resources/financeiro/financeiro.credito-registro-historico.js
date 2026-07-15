// GET /financeiro/credito-registro/:grupo/historico
// Todas as versões de uma análise (do mais recente ao mais antigo) + os anexos
// vinculados ao grupo. Perm 8006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/credito-registro/:grupo/historico',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const grupo = Number(req.params.grupo);
    if (!Number.isInteger(grupo) || grupo <= 0) return res.status(400).json({ message: 'grupo inválido.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT id, grupo_id, versao, vigente, substituido_por,
               bu_cod, bu_nome, pedido, cliente_cod, cliente_loja, cliente_nome, cnpj,
               valor_total, valor_entrada, parcelas_qtd, parcelas_valor,
               tipo_analise, canal, canal_origem, resultado, motivos, parecer,
               analista_nome, criado_em
          FROM tab_credito_registro
         WHERE grupo_id = @g
         ORDER BY versao DESC`, { g: grupo });
      if (!rows.length) return res.status(404).json({ message: 'Análise não encontrada.' });

      const anexos = await Pg.connectAndQuery(`
        SELECT a.id, a.titulo, a.nome_original, a.mime_type, a.tamanho_bytes, a.url, a.enviado_em,
               u.nome AS enviado_por_nome
          FROM tab_credito_anexo a
          LEFT JOIN tab_intranet_usr u ON u.id = a.enviado_por
         WHERE a.registro_id = @g
         ORDER BY a.enviado_em DESC`, { g: grupo });

      const versoes = rows.map(r => ({
        id: r.id, versao: r.versao, vigente: r.vigente, substituidoPor: r.substituido_por,
        buCod: trim(r.bu_cod), buNome: trim(r.bu_nome), pedido: trim(r.pedido),
        clienteCod: trim(r.cliente_cod), clienteLoja: trim(r.cliente_loja), clienteNome: trim(r.cliente_nome), cnpj: trim(r.cnpj),
        valorTotal: N(r.valor_total), valorEntrada: N(r.valor_entrada),
        parcelasQtd: N(r.parcelas_qtd), parcelasValor: N(r.parcelas_valor),
        tipoAnalise: trim(r.tipo_analise), canal: trim(r.canal), canalOrigem: trim(r.canal_origem),
        resultado: trim(r.resultado), motivos: Array.isArray(r.motivos) ? r.motivos : [],
        parecer: trim(r.parecer), analistaNome: trim(r.analista_nome), criadoEm: r.criado_em
      }));

      return res.json({
        grupoId: grupo,
        versoes,
        anexos: anexos.map(a => ({
          id: a.id, titulo: trim(a.titulo), nomeOriginal: trim(a.nome_original),
          mimeType: trim(a.mime_type), tamanhoBytes: N(a.tamanho_bytes),
          url: trim(a.url), enviadoEm: a.enviado_em, enviadoPor: trim(a.enviado_por_nome)
        }))
      });
    } catch (err) {
      console.error('financeiro/credito-registro historico:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
