// POST /qualificacao/fornecedores/:id/documentos — registra um documento da qualificação
// (PRO 7.3.7 item 5.4). Perm 23003+ (Engenharia — "realizar a qualificação" e "analisar os
// documentos", PRO 4.1). Duas origens do arquivo:
//   - multipart 'arquivo' (a Engenharia anexa);
//   - anexo_id de um arquivo que o FORNECEDOR enviou no link do FORM 7.3.21/7.3.28 — a
//     Engenharia confere e registra com número/validade (origem FORNECEDOR).
//
// status: VIGENTE (padrão) | PROTOCOLADO (protocolo de solicitação/renovação: exige o PRAZO
// de regularização — PRO 5.4) | DISPENSADO (não aplicável, com justificativa — Nota 2 do FORM).
// O documento anterior do mesmo tipo vira SUBSTITUIDO (histórico preservado).

const multer = require('multer');
const crypto = require('crypto');
const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const data = (v) => { const s = Q.trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/documentos',
  middlewares: [Q.mw(app, 'engenharia'), upload.single('arquivo')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const b = req.body || {};
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const [tipo] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_tipo_documento WHERE id = @t`, { t: Number(b.tipo_documento_id) || 0 });
      if (!tipo) return res.status(400).json({ message: 'Tipo de documento inválido.' });
      const status = ['VIGENTE', 'PROTOCOLADO', 'DISPENSADO'].includes(b.status) ? b.status : 'VIGENTE';
      if (status === 'DISPENSADO' && !Q.nul(b.justificativa)) return res.status(400).json({ message: 'Justifique por que o documento não se aplica a este fornecedor.' });

      // arquivo do fornecedor (link público) — precisa ser deste fornecedor, de uma ficha, e ainda não registrado
      let anexoFornecedor = null;
      if (!req.file && Number(b.anexo_id)) {
        [anexoFornecedor] = await Pg.connectAndQuery(
          `SELECT a.id, a.nome_arquivo, a.entidade, a.excluido,
                  EXISTS (SELECT 1 FROM tab_qf_documento d WHERE d.anexo_id = a.id) ja_registrado
             FROM tab_qf_anexo a WHERE a.id = @a AND a.fornecedor_id = @f`, { a: Number(b.anexo_id), f: id });
        if (!anexoFornecedor || anexoFornecedor.entidade !== 'ficha' || anexoFornecedor.excluido) return res.status(400).json({ message: 'Arquivo do fornecedor não encontrado.' });
        if (anexoFornecedor.ja_registrado) return res.status(409).json({ message: 'Este arquivo já foi registrado como documento.' });
      }
      if (status !== 'DISPENSADO' && !req.file && !anexoFornecedor) return res.status(400).json({ message: 'Anexe o arquivo do documento (ou do protocolo).' });
      const validade = data(b.data_validade);
      const prazo = data(b.prazo_regularizacao);
      if (status === 'VIGENTE' && tipo.exige_validade && !validade) return res.status(400).json({ message: `${tipo.nome}: informe a data de validade.` });
      if (status === 'PROTOCOLADO' && !prazo) return res.status(400).json({ message: 'Protocolo: informe o prazo definido para o envio do documento definitivo (PRO 7.3.7 item 5.4).' });
      if (status === 'PROTOCOLADO' && prazo < new Date().toISOString().slice(0, 10)) return res.status(400).json({ message: 'O prazo de regularização já passou.' });
      if (status === 'VIGENTE' && validade && validade < new Date().toISOString().slice(0, 10)) return res.status(400).json({ message: 'Documento já vencido — registre o protocolo de renovação ou peça o documento atualizado.' });

      const u = Q.usuario(req);
      const origem = anexoFornecedor ? 'FORNECEDOR' : 'INTERNO';
      let doc;
      await Q.tx(Pg, async (q) => {
        let anexoId = anexoFornecedor ? anexoFornecedor.id : null;
        if (req.file) {
          const [a] = await q(
            `INSERT INTO tab_qf_anexo (entidade, entidade_id, fornecedor_id, categoria, nome_arquivo, mime_type, tamanho_bytes, sha256, conteudo, descricao, enviado_por)
             VALUES ('documento', 0, @f, 'DOCUMENTO', @nome, @mime, @tam, @sha, @bin, @desc, @u) RETURNING id`,
            { f: id, nome: req.file.originalname.slice(0, 255), mime: req.file.mimetype, tam: req.file.size,
              sha: crypto.createHash('sha256').update(req.file.buffer).digest('hex'), bin: req.file.buffer, desc: tipo.nome.slice(0, 255), u: u.id });
          anexoId = a.id;
        }
        const anteriores = await q(
          `UPDATE tab_qf_documento SET status = 'SUBSTITUIDO', atualizado_por = @u, atualizado_em = NOW()
            WHERE fornecedor_id = @f AND tipo_documento_id = @t AND status IN ('VIGENTE','PROTOCOLADO','DISPENSADO') RETURNING id`,
          { f: id, t: tipo.id, u: u.id });
        [doc] = await q(
          `INSERT INTO tab_qf_documento (fornecedor_id, tipo_documento_id, numero, data_emissao, data_validade, status, prazo_regularizacao, anexo_id, origem,
                  justificativa, observacoes, aprovado_por, aprovado_em, enviado_por, atualizado_por)
           VALUES (@f, @t, @num, @emi, @val, @st, @prazo, @anexo, @origem, @just, @obs, @aprov, CASE WHEN @aprov::int IS NULL THEN NULL ELSE NOW() END, @u, @u) RETURNING *`,
          { f: id, t: tipo.id, num: Q.nul(b.numero), emi: data(b.data_emissao), val: status === 'DISPENSADO' ? null : validade,
            st: status, prazo: status === 'PROTOCOLADO' ? prazo : null, anexo: anexoId, origem,
            just: Q.nul(b.justificativa), obs: Q.nul(b.observacoes), aprov: status === 'DISPENSADO' ? u.id : null, u: u.id });
        // o arquivo enviado pela Engenharia passa a apontar para o documento; o do fornecedor continua preso à ficha
        if (req.file) await q(`UPDATE tab_qf_anexo SET entidade_id = @d WHERE id = @a`, { d: doc.id, a: anexoId });
        await Q.log(Pg, req, {
          entidade: 'documento', entidadeId: doc.id, fornecedorId: id, acao: status === 'DISPENSADO' ? 'DISPENSAR' : 'ENVIAR',
          mudancas: [{ campo: 'tipo', para: tipo.codigo }, { campo: 'status', para: status }, { campo: 'origem', para: origem },
            ...(validade && status !== 'DISPENSADO' ? [{ campo: 'data_validade', para: validade }] : []),
            ...(status === 'PROTOCOLADO' ? [{ campo: 'prazo_regularizacao', para: prazo }] : []),
            ...(req.file ? [{ campo: 'arquivo', para: req.file.originalname }] : []),
            ...(anexoFornecedor ? [{ campo: 'arquivo_do_fornecedor', para: anexoFornecedor.nome_arquivo }] : []),
            ...anteriores.map(a => ({ campo: 'substituiu_documento', para: a.id }))],
          motivo: Q.nul(b.justificativa)
        }, q);
      });

      // suspenso por documento e agora sem pendência vencida → a Engenharia pode reativar
      let podeReativar = false;
      if (f.status_qualificacao === 'SUSPENSO' && f.suspensao_tipo === 'DOCUMENTO') {
        const ck = await Q.checklistFornecedor(Pg, f);
        podeReativar = ck.vencidos === 0;
      }
      return res.json({ ok: true, documento: doc, podeReativar, exigido: R.regraDocumento(tipo, f.criticidades) });
    } catch (err) { return Q.falha(res, 'registrar o documento', err); }
  }
});
