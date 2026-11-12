// Universidade · Certificados de treinamento (PDF, pdfkit).
//
// 1 certificado por EVIDÊNCIA aprovada (vw_uni_evidencia): lançamento do RH, presença em
// turma vinculada ou curso EAD concluído. Frente = modelo oficial do Educacional
// (assets/universidade/certificado-fundo.jpg — troque o arquivo p/ mudar o modelo, ou aponte
// UNI_CERT_FUNDO) com nome, treinamento, data, local, carga, ministrante, responsável,
// validade e código. Verso = conteúdo programático do curso (tab_uni_curso.descricao).
// Cada emissão fica em tab_uni_certificado (código único GNT-AAAA-NNNNNN, p/ conferência).

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const FUNDO = process.env.UNI_CERT_FUNDO || path.join(__dirname, '..', 'assets', 'universidade', 'certificado-fundo.jpg');
const W = 841.89;  // A4 paisagem (pt)
const H = 595.28;
// área branca do modelo (proporções medidas na arte do Educacional)
const CARD = { x: W * 0.0825, y: H * 0.179, w: W * 0.835, h: H * 0.713 };
const AZUL = '#17457e';
const TEXTO = '#1a2740';
const CINZA = '#55627a';

const MODALIDADE = { presencial: 'presencial', online: 'online (ao vivo)', ead: 'a distância (EAD)', externo: 'externo' };
const fmtData = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
const fmtHoras = (h) => {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
};
const limpa = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ dados
// Tudo o que vai no certificado de uma evidência. null = não existe ou não está aprovada.
async function dadosCertificado(Pg, ref) {
  const r = await Pg.connectAndQuery(`
    SELECT e.ref, e.fonte, e.colaborador_id, e.curso_id, e.data::text AS data, e.modalidade, e.carga_h,
           e.instrutor, e.origem, e.aprovado, e.nota, e.lote_id, e.registro_id,
           c.nome, c.depto_codigo, c.user_id,
           cu.codigo AS curso_codigo, cu.titulo, cu.descricao, cu.carga_horaria_h, cu.validade_meses,
           cu.responsavel_nome, cu.ministrante AS curso_ministrante, cu.instrutor_nome,
           cu.tipo_treinamento AS curso_tipo, cu.empresa_externa,
           v.id AS versao_id, v.revisao, v.conteudo AS versao_conteudo,
           l.local AS lote_local, l.verificacao, l.empresa AS lote_empresa, l.tipo_treinamento AS lote_tipo,
           rg.empresa AS reg_empresa, rg.tipo_treinamento AS reg_tipo, rg.verificacao AS reg_verificacao,
           s.local AS sessao_local
      FROM vw_uni_evidencia e
      JOIN tab_uni_colaborador c ON c.id = e.colaborador_id
      JOIN tab_uni_curso cu      ON cu.id = e.curso_id
      LEFT JOIN tab_uni_curso_versao v ON v.id = COALESCE(e.versao_id, (
             SELECT v2.id FROM tab_uni_curso_versao v2
              WHERE v2.curso_id = e.curso_id AND v2.status <> 'rascunho' AND v2.vigente_desde <= e.data
              ORDER BY v2.vigente_desde DESC, v2.id DESC LIMIT 1))
      LEFT JOIN tab_uni_registro rg       ON rg.id = e.registro_id
      LEFT JOIN tab_uni_registro_lote l   ON l.id = e.lote_id
      LEFT JOIN tab_treina_inscricao i    ON e.fonte = 'turma' AND i.id = split_part(e.ref, ':', 2)::int
      LEFT JOIN tab_treina_sessao s       ON s.id = i.sessao_id
     WHERE e.ref = @ref`, { ref });
  const d = r[0];
  if (!d || !d.aprovado || !d.data) return null;

  const tipo = d.reg_tipo || d.lote_tipo || d.curso_tipo || 'interno';
  const empresa = limpa(d.reg_empresa || d.lote_empresa || (tipo === 'externo' ? d.empresa_externa : ''));
  const ministrante = limpa(d.instrutor || d.curso_ministrante || d.instrutor_nome || '');
  const local = limpa(d.lote_local || d.sessao_local || (d.fonte === 'ead' ? 'Universidade Gnatus — plataforma online' : ''));
  const carga = d.carga_h != null ? d.carga_h : d.carga_horaria_h;
  let validoAte = null;
  if (d.validade_meses) {
    const [a, m, dia] = d.data.split('-').map(Number);
    const dt = new Date(Date.UTC(a, m - 1 + Number(d.validade_meses), dia));
    validoAte = dt.toISOString().slice(0, 10);
  }
  const verif = d.reg_verificacao || d.verificacao;
  const conclusao = d.fonte === 'ead' || verif === 'avaliacao';

  return {
    ref: d.ref, colaboradorId: d.colaborador_id, cursoId: d.curso_id, versaoId: d.versao_id,
    deptoCodigo: d.depto_codigo, userId: d.user_id,
    nome: limpa(d.nome), cursoCodigo: d.curso_codigo, titulo: limpa(d.titulo), revisao: d.revisao,
    conteudo: String(d.descricao || '').trim() || String(d.versao_conteudo || '').trim(),
    data: d.data, modalidade: d.fonte === 'ead' ? 'ead' : (d.modalidade || 'presencial'),
    cargaH: carga, local, ministrante, empresa, tipo, responsavel: limpa(d.responsavel_nome || ''),
    nota: d.nota != null ? Number(d.nota) : null, validoAte, conclusao
  };
}

// Registra (ou reemite) e devolve o código do certificado.
async function registrarEmissao(Pg, d, userId) {
  const r = await Pg.connectAndQuery(`
    WITH s AS (SELECT nextval('tab_uni_certificado_id_seq') AS id)
    INSERT INTO tab_uni_certificado (id, codigo, evidencia_ref, colaborador_id, curso_id, versao_id, data_conclusao,
                                     valido_ate, carga_h, modalidade, ministrante, empresa, emitido_por)
    SELECT s.id, 'GNT-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(s.id::text, 6, '0'),
           @ref, @colab, @curso, @versao, @data, @valido, @carga, @modal, @minis, @emp, @uid
      FROM s
    ON CONFLICT (evidencia_ref) DO UPDATE SET
      ultima_emissao = NOW(), vezes_emitido = tab_uni_certificado.vezes_emitido + 1,
      valido_ate = EXCLUDED.valido_ate, ministrante = EXCLUDED.ministrante, empresa = EXCLUDED.empresa
    RETURNING codigo, emitido_em`,
    {
      ref: d.ref, colab: d.colaboradorId, curso: d.cursoId, versao: d.versaoId || null, data: d.data,
      valido: d.validoAte, carga: d.cargaH == null ? null : Number(d.cargaH), modal: d.modalidade,
      minis: d.ministrante || null, emp: d.empresa || null, uid: userId || null
    });
  return { codigo: r[0].codigo, emitidoEm: r[0].emitido_em };
}

// ------------------------------------------------------------------ desenho
function fundo(doc) {
  if (fs.existsSync(FUNDO)) doc.image(FUNDO, 0, 0, { width: W, height: H });
  else {
    doc.rect(0, 0, W, H).fill('#5b5f63');
    doc.rect(CARD.x, CARD.y, CARD.w, CARD.h).fill('#ffffff');
  }
}

// Escreve centralizado no cartão, reduzindo a fonte até caber em `maxLinhas`.
function centro(doc, texto, y, { font = 'Helvetica', size = 12, min = 8, cor = TEXTO, maxLinhas = 1, margem = 60 } = {}) {
  const largura = CARD.w - margem * 2;
  let sz = size;
  doc.font(font);
  while (sz > min) {
    doc.fontSize(sz);
    const h = doc.heightOfString(texto, { width: largura, align: 'center' });
    if (h <= doc.currentLineHeight(true) * maxLinhas + 1) break;
    sz -= 0.5;
  }
  doc.fontSize(sz).fillColor(cor).text(texto, CARD.x + margem, y, { width: largura, align: 'center' });
  return doc.y;
}

function frente(doc, d, emissao) {
  fundo(doc);
  let y = CARD.y + 22;
  y = centro(doc, d.conclusao ? 'CERTIFICADO DE CONCLUSÃO' : 'CERTIFICADO DE PARTICIPAÇÃO', y, { font: 'Helvetica-Bold', size: 21, cor: AZUL });
  y = centro(doc, 'Certificamos que', y + 14, { size: 12, cor: CINZA });
  y = centro(doc, d.nome, y + 6, { font: 'Helvetica-Bold', size: 25, min: 14 });
  const modal = d.tipo === 'externo' && d.modalidade !== 'ead' ? 'externo' : (MODALIDADE[d.modalidade] || 'presencial');
  y = centro(doc, `${d.conclusao ? 'concluiu o' : 'participou do'} treinamento ${modal}`, y + 10, { size: 12, cor: CINZA });
  y = centro(doc, `“${d.titulo}”`, y + 6, { font: 'Helvetica-Bold', size: 18, min: 11, cor: '#1e5fb5', maxLinhas: 2 });
  const fim = d.conclusao && d.nota != null ? `com aproveitamento de ${d.nota.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%.` : 'concluindo com êxito.';
  y = centro(doc, fim, y + 6, { size: 12, cor: CINZA });
  centro(doc, [d.cursoCodigo, d.revisao ? `Revisão ${d.revisao}` : null].filter(Boolean).join(' · '), y + 6, { size: 9, cor: '#64748b' });

  // bloco de informações (esquerda, abaixo do texto — as assinaturas ficam à direita)
  const x = CARD.x + 34;
  const larg = W * 0.40;
  let yi = H * 0.595;
  const linha = (rotulo, valor) => {
    if (!valor) return;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEXTO).text(`${rotulo}: `, x, yi, { continued: true, width: larg });
    doc.font('Helvetica').fillColor(CINZA).text(valor, { width: larg });
    yi = doc.y + 2.5;
  };
  linha('Data', fmtData(d.data));
  linha('Local', d.local);
  linha('Carga horária', fmtHoras(d.cargaH));
  linha('Ministrante', [d.ministrante, d.empresa ? `(${d.empresa})` : null].filter(Boolean).join(' ') || null);
  linha('Responsável pelo treinamento', d.responsavel);
  linha('Validade', d.validoAte ? `até ${fmtData(d.validoAte)}` : 'sem prazo de validade');

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(AZUL)
    .text(`Código do certificado: ${emissao.codigo}`, x, H * 0.835, { width: larg });
  doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
    .text(`Emitido pela Universidade Gnatus (intranet) em ${fmtData(new Date().toISOString())}. O conteúdo programático está no verso.`, x, doc.y + 1, { width: larg });
}

function verso(doc, d, emissao) {
  doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
  fundo(doc);
  // esconde as assinaturas do modelo (o verso não leva assinatura)
  doc.rect(W * 0.50, H * 0.57, W * 0.36, H * 0.17).fill('#ffffff');

  let y = CARD.y + 22;
  y = centro(doc, 'CONTEÚDO PROGRAMÁTICO', y, { font: 'Helvetica-Bold', size: 18, cor: AZUL });
  y = centro(doc, d.titulo, y + 6, { font: 'Helvetica-Bold', size: 13, min: 9, maxLinhas: 2 });
  y = centro(doc, [d.cursoCodigo, d.revisao ? `Revisão ${d.revisao}` : null, fmtHoras(d.cargaH)].filter(Boolean).join(' · '), y + 2, { size: 9, cor: '#64748b' });

  const x = CARD.x + 50;
  const largura = CARD.w - 100;
  const topo = y + 14;
  const limite = H * 0.80;
  const texto = (d.conteudo || 'Conteúdo programático não informado no cadastro do curso.')
    .split(/\r?\n/).map(l => l.trimEnd()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join('\n');
  let sz = 11;
  doc.font('Helvetica');
  while (sz > 6.5) {
    doc.fontSize(sz);
    if (doc.heightOfString(texto, { width: largura, lineGap: 1.5 }) <= limite - topo) break;
    sz -= 0.5;
  }
  doc.fontSize(sz).fillColor(TEXTO).text(texto, x, topo, { width: largura, lineGap: 1.5, height: limite - topo, ellipsis: true });

  doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
    .text(`Certificado ${emissao.codigo} · ${d.nome}`, CARD.x + 34, H * 0.84, { width: W * 0.45 });
}

// Gera 1 PDF com os certificados (2 páginas cada). itens = [{ dados, emissao }].
function gerarPdf(itens) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: false,
      info: { Title: 'Certificado — Universidade Gnatus', Author: 'Gnatus' } });
    const partes = [];
    doc.on('data', c => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    for (const { dados, emissao } of itens) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
      frente(doc, dados, emissao);
      verso(doc, dados, emissao);
    }
    doc.end();
  });
}

module.exports = { dadosCertificado, registrarEmissao, gerarPdf, FUNDO };
