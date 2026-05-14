// GET /producao/registro/:id/pdf-final
// Gera o "Registro Historico do Produto" em PDF — equivalente ao RHP que era
// montado manualmente no Pipefy/Excel. Inclui:
//   - Cabecalho: OP, NumSerie, Produto, datas
//   - Status de cada uma das 12 etapas (responsavel, data, observacao, RNC,
//     dados_extras formatados)
//   - Lista de anexos com link clicavel pro SharePoint (web_url)
//   - Rodape: gerado em / por
//
// Resposta: application/pdf streamed (Content-Disposition inline pra abrir
// no browser; o operador salva/imprime de la).
//
// Permissao: 14001 (operar), 14002 (admin) ou 14003 (dashboard).

const PDFDocument = require('pdfkit');
const Auditoria = require('../../services/auditoria');
const { ETAPAS } = require('./_etapas');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14001, 14002, 14003]);

const fmtDate = (v) => {
  if (!v) return '-';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('pt-BR');
};
const fmtDateTime = (v) => {
  if (!v) return '-';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString('pt-BR');
};
const corStatus = (s) => {
  switch (String(s || '').toLowerCase()) {
    case 'aprovado':     return '#1f8a4f';
    case 'reprovado':    return '#c0392b';
    case 'em_andamento': return '#1e5fb5';
    default:             return '#808080';
  }
};

module.exports = (app) => ({
  verb: 'get',
  route: '/registro/:id/pdf-final',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      // Carrega tudo
      const headRows = await Pg.connectAndQuery(`
        SELECT r.*, u.nome AS criado_por_nome
          FROM tab_prod_registro r
          LEFT JOIN tab_intranet_usr u ON u.id = r.criado_por
         WHERE r.id = @id`, { id });
      if (!headRows.length) return res.status(404).json({ message: 'Registro nao encontrado.' });
      const reg = headRows[0];

      const etapasRows = await Pg.connectAndQuery(`
        SELECT e.*, u.nome AS responsavel_nome_atual, u.email AS responsavel_email
          FROM tab_prod_registro_etapa e
          LEFT JOIN tab_intranet_usr u ON u.id = e.responsavel_id
         WHERE e.registro_id = @id
         ORDER BY e.etapa_codigo`, { id });

      const anexosRows = await Pg.connectAndQuery(`
        SELECT a.*, u.nome AS enviado_por_nome
          FROM tab_prod_registro_anexo a
          LEFT JOIN tab_intranet_usr u ON u.id = a.enviado_por
         WHERE a.registro_id = @id
         ORDER BY COALESCE(a.etapa_codigo, 99), a.enviado_em`, { id });

      const userAtual = req.user && req.user[0];

      // Headers — inline pra abrir no browser; pode salvar de la
      const filename = `RHP_${(reg.op_protheus || 'sem-op').replace(/[^\w-]/g, '')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 50, left: 40, right: 40 },
        info: {
          Title: `Registro Historico do Produto - OP ${reg.op_protheus}`,
          Author: 'Intranet GNATUS',
          Subject: reg.produto_descricao || ''
        }
      });
      doc.pipe(res);

      // ========== Cabecalho ==========
      doc.rect(40, 40, 515, 60).fill('#1a3f82');
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(16)
        .text('REGISTRO HISTORICO DO PRODUTO', 50, 55);
      doc.font('Helvetica').fontSize(9)
        .text(`Documento gerado pela Intranet GNATUS em ${fmtDateTime(new Date())}`, 50, 78);
      if (userAtual) doc.text(`Solicitante: ${userAtual.NOME || userAtual.nome || '-'}`, 50, 91);
      doc.fillColor('#000').moveDown(2);

      doc.y = 115;

      // ========== Bloco identificacao ==========
      const numSerie = Array.isArray(reg.numeros_serie) && reg.numeros_serie.length
        ? reg.numeros_serie.join(', ')
        : '-';
      const linhasHead = [
        ['OP Protheus',     reg.op_protheus || '-',       'Filial',        reg.op_filial || '-'],
        ['Produto',         reg.produto_codigo || '-',    'Quantidade',    String(Number(reg.quantidade || 0))],
        ['Descricao',       (reg.produto_descricao || '-').slice(0, 80), 'Status', reg.status || '-'],
        ['Numero(s) serie', numSerie,                     'Fase atual',    `${reg.fase_atual}/12`],
        ['Inicio previsto', fmtDate(reg.data_inicio_prev), 'Fim previsto', fmtDate(reg.data_termino_prev)],
        ['Origem',          reg.origem || '-',            'Criado em',     fmtDateTime(reg.criado_em)]
      ];
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a3f82').text('IDENTIFICACAO', 40, doc.y);
      doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#1a3f82').stroke();
      doc.moveDown(0.5);
      let y0 = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#000');
      const colW = 257.5;
      linhasHead.forEach(linha => {
        doc.font('Helvetica-Bold').fillColor('#5b6b85').text(linha[0], 40, y0, { width: 90 });
        doc.font('Helvetica').fillColor('#000').text(String(linha[1]), 130, y0, { width: colW - 90 });
        doc.font('Helvetica-Bold').fillColor('#5b6b85').text(linha[2], 40 + colW, y0, { width: 90 });
        doc.font('Helvetica').fillColor('#000').text(String(linha[3]), 130 + colW, y0, { width: colW - 90 });
        y0 += 16;
      });
      doc.y = y0 + 8;

      // ========== Etapas ==========
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a3f82').text('ETAPAS DO PROCESSO (12)', 40, doc.y);
      doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#1a3f82').stroke();
      doc.moveDown(0.5);

      // Pra cada etapa do catalogo + dados gravados
      ETAPAS.forEach((meta, idx) => {
        const dados = etapasRows.find(x => x.etapa_codigo === meta.codigo) || null;
        const status = dados?.status || 'pendente';
        const cor = corStatus(status);

        // Quebra de pagina se restar pouco espaco
        if (doc.y > 720) doc.addPage();

        // Bullet com numero
        doc.circle(50, doc.y + 6, 8).fillAndStroke(cor, cor);
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9).text(String(meta.codigo), 47, doc.y + 2.5, { lineBreak: false });

        // Nome + status
        doc.fillColor('#000').font('Helvetica-Bold').fontSize(11).text(meta.nome, 70, doc.y, { lineBreak: false });
        doc.font('Helvetica').fontSize(8).fillColor(cor).text(`  [${status.toUpperCase()}]`, 70 + doc.widthOfString(meta.nome), doc.y - 14, { lineBreak: false });

        let y = doc.y + 4;
        const linhasMeta = [];
        if (dados?.responsavel_nome_atual || dados?.responsavel_nome) {
          linhasMeta.push(`Responsavel: ${dados.responsavel_nome_atual || dados.responsavel_nome}${dados.responsavel_email ? ` (${dados.responsavel_email})` : ''}`);
        }
        if (dados?.data_execucao) linhasMeta.push(`Data execucao: ${fmtDate(dados.data_execucao)}`);
        if (dados?.rnc_numero) linhasMeta.push(`RNC: ${dados.rnc_numero}`);
        if (dados?.observacao) linhasMeta.push(`Observacao: ${dados.observacao}`);

        // Dados extras formatados
        const dx = dados?.dados_extras;
        if (dx && typeof dx === 'object' && Object.keys(dx).length > 0) {
          Object.entries(dx).forEach(([k, v]) => {
            let val = v;
            if (Array.isArray(v)) val = v.map(x => x === true ? '✔' : x === false ? '✗' : String(x)).join(', ');
            else if (typeof v === 'object' && v !== null) val = JSON.stringify(v);
            if (val !== '' && val != null) linhasMeta.push(`${k}: ${val}`);
          });
        }

        if (!linhasMeta.length) linhasMeta.push('(sem dados preenchidos)');

        doc.font('Helvetica').fontSize(8.5).fillColor('#3a4862');
        linhasMeta.forEach(l => {
          doc.text(l, 70, y, { width: 480 });
          y = doc.y;
        });

        if (dados?.atualizado_em) {
          doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#8093ac')
            .text(`Atualizado em ${fmtDateTime(dados.atualizado_em)}`, 70, y);
          y = doc.y;
        }

        doc.moveTo(40, y + 4).lineTo(555, y + 4).strokeColor('#e0e6f0').stroke();
        doc.y = y + 8;
      });

      // ========== Anexos ==========
      if (doc.y > 680) doc.addPage();
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a3f82').text(`ANEXOS (${anexosRows.length})`, 40, doc.y);
      doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#1a3f82').stroke();
      doc.moveDown(0.5);

      if (!anexosRows.length) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#8093ac')
          .text('Nenhum anexo associado a este registro.', 40, doc.y);
      } else {
        doc.font('Helvetica').fontSize(8.5).fillColor('#000');
        anexosRows.forEach(a => {
          if (doc.y > 760) doc.addPage();
          const etapaTxt = a.etapa_codigo ? `Etapa ${String(a.etapa_codigo).padStart(2, '0')}` : 'Geral';
          const tipoTxt = a.tipo ? ` [${a.tipo}]` : '';
          doc.font('Helvetica-Bold').text(`• ${etapaTxt}${tipoTxt}: `, 40, doc.y, { continued: true, link: null });
          doc.font('Helvetica').fillColor('#1e5fb5')
            .text(a.titulo, { link: a.url || null, underline: !!a.url, continued: false });
          doc.fillColor('#5b6b85').font('Helvetica').fontSize(7.5)
            .text(`   ${a.enviado_por_nome || '-'} · ${fmtDateTime(a.enviado_em)}${a.url ? ' · ' + a.url.slice(0, 90) : ''}`,
                  { width: 515 });
          doc.fillColor('#000').fontSize(8.5);
          doc.moveDown(0.3);
        });
      }

      // ========== Rodape em todas as paginas ==========
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.font('Helvetica').fontSize(7.5).fillColor('#8093ac');
        doc.text(`Intranet GNATUS · OP ${reg.op_protheus} · ${fmtDateTime(new Date())}`,
          40, 805, { width: 410, align: 'left' });
        doc.text(`Pagina ${i - range.start + 1} de ${range.count}`,
          450, 805, { width: 105, align: 'right' });
      }

      doc.end();

      // Auditoria — fora do try/catch principal pra nao bloquear streaming
      Auditoria.registrar(app, {
        modulo: 'Producao', submodulo: 'PDF', acao: 'EXPORT',
        severidade: 'INFO', req,
        entidade: 'prod_registro', entidadeId: id,
        descricao: `Gerou PDF Final do RHP — OP ${reg.op_protheus} (${anexosRows.length} anexos)`,
        meta: { etapas: etapasRows.length, anexos: anexosRows.length }
      });
    } catch (err) {
      console.error('Erro producao/pdf-final:', err);
      // Se ja comecou a stream, nao da pra mandar JSON
      if (!res.headersSent) {
        return res.status(500).json({ message: 'Erro ao gerar PDF: ' + err.message });
      }
      try { res.end(); } catch { /* ignore */ }
    }
  }
});
