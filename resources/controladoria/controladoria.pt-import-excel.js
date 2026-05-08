// POST /controladoria/pt/import-excel — importa planilha de Poder de Terceiros.
// Multipart: campo 'arquivo' = .xlsx
// Query: ?dry=true → so valida e retorna preview (nao grava)
//
// Layout 2026 (planilha "GERAL", header na linha 7):
//   A=ATUALIZADO_EM   B=NOVO_VENCIMENTO   C=DESTINATARIO   D=Nº PEDIDO
//   E=SOLICITANTE     F=RESPONSAVEL       G=PRODUTOS       H=FINALIDADE
//   I=ULT.VALIDACAO   J=PRAZO[dias]       K=NF SAIDA       L=CFOP
//   M=NATUREZA OP     N=CONTRATO COMODATO O=VALOR          P=DATA EMISSAO NF
//   Q=DATA EXPEDICAO  R=DATA VENCIMENTO   S=FORMA FINAL.   T=EQUIP CHEGOU
//   U=NF FINALIZACAO  V=DATA VENDA/RET    W=CFOP2          X=VALOR3
//   Y=Nº PEDIDO VENDA Z=COBRANCA 1a       AA=COBRANCA 2a
//
// O detector de header procura "DESTINATARIO" em qualquer das primeiras 10
// linhas, em qualquer das 5 primeiras colunas — robusto a futuras mudancas
// pequenas. Permissao 0 (admin).

const ExcelJS = require('exceljs');
const multer = require('multer');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([0]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// trim() de campo TEXTO. Date / object viram null — Date especialmente
// importante: a planilha tem celulas de data soltas (ex linhas-rotulo) que
// se cairem aqui viram strings tipo "Tue Apr 07 2026 21:00:00 GMT-0300 (...)"
// e estouram varchar curtos.
const trim = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return null;
  if (typeof v === 'object') {
    if (v.text)        return String(v.text).trim() || null;
    if (v.result != null && !(v.result instanceof Date)) return String(v.result).trim() || null;
    if (v.richText)    return v.richText.map(r => r.text).join('').trim() || null;
    return null;
  }
  return String(v).trim() || null;
};

// Date / serial Excel / string ISO / DD/MM/YYYY / Date.toString() JS
function toISODate (v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'object' && v.result instanceof Date) {
    return v.result.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') {
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // Fallback: Date.toString() JS ("Mon Apr 25 2022 21:00:00 GMT-0300 (...)") —
  // a planilha 2026 da fiscal tem varias colunas de data nesse formato. Date()
  // parseia direto, mas por seguranca conferimos validade.
  if (/^\w{3} \w{3} \d{1,2} \d{4}/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function toNumber (v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in v) return Number(v.result) || null;
  const s = String(v).replace(/[R$\s.]/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toBool (v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (['SIM', 'S', 'TRUE', '1', 'YES', 'Y'].includes(s)) return true;
  if (['NAO', 'NÃO', 'N', 'FALSE', '0', 'NO'].includes(s)) return false;
  return null;
}

const FORMAS_VALIDAS = ['RETORNO', 'PARCIAL', 'VENDA', 'RENOVACAO', 'TROCA'];
function normalizarForma (v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (FORMAS_VALIDAS.includes(s)) return s;
  if (s.includes('RETORN')) return 'RETORNO';
  if (s.includes('VENDA')) return 'VENDA';
  if (s.includes('RENOV')) return 'RENOVACAO';
  if (s.includes('TROC'))  return 'TROCA';
  if (s.includes('PARCIAL')) return 'PARCIAL';
  return null;
}

// Localiza a linha do header pela palavra "DESTINATARIO" e devolve em qual
// coluna ela esta — assim qualquer deslocamento futuro de coluna eh detectado.
function localizarLayout (ws) {
  for (let r = 1; r <= 15; r++) {
    const row = ws.getRow(r);
    for (let col = 1; col <= 8; col++) {
      const v = row.getCell(col).value;
      const s = (typeof v === 'string' ? v : (v?.text || '')).trim().toUpperCase();
      if (s === 'DESTINATARIO' || s === 'DESTINATÁRIO') {
        // offset = colunas antes de DESTINATARIO
        return { headerRow: r, dataInicio: r + 1, offsetDestinatario: col };
      }
    }
  }
  return { headerRow: 7, dataInicio: 8, offsetDestinatario: 3 };  // fallback layout 2026
}

module.exports = (app) => ({
  verb: 'post',
  route: '/pt/import-excel',
  middlewares: [requirePerm(app), upload.single('arquivo')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const dryRun = String(req.query.dry || '').toLowerCase() === 'true';

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Arquivo .xlsx obrigatorio (campo "arquivo").' });
    }

    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      // Procura aba "GERAL" primeiro (planilha 2026); fallback pra primeira aba
      const ws = wb.getWorksheet('GERAL') || wb.worksheets[0];
      if (!ws) return res.status(400).json({ message: 'Planilha nao tem abas.' });

      const layout = localizarLayout(ws);
      // Mapeia coluna do BD → numero da coluna na planilha, em funcao do offset
      // (DESTINATARIO esta na col `offsetDestinatario`; tudo a partir dali e
      // alinhado por ORDEM com o layout esperado).
      const D = layout.offsetDestinatario;     // coluna de DESTINATARIO
      // Colunas a esquerda do destinatario (offsets negativos): se houver 2
      // colunas extras (ATUALIZADO_EM e NOVO_VENCIMENTO), esta a 2 e 1 antes
      const COL = {
        atualizado: D >= 3 ? D - 2 : null,    // ATUALIZADO EM (planilha 2026)
        novoVenc:   D >= 2 ? D - 1 : null,    // NOVO VENCIMENTO   (planilha 2026)
        destinatario: D,
        pedido:        D + 1,
        solicitante:   D + 2,
        responsavel:   D + 3,
        produtos:      D + 4,
        finalidade:    D + 5,
        ultValidacao:  D + 6,
        prazoDias:     D + 7,
        nfSaida:       D + 8,
        cfop:          D + 9,
        natureza:      D + 10,
        contrato:      D + 11,
        valor:         D + 12,
        dataEmissao:   D + 13,
        dataExpedicao: D + 14,
        dataVencto:    D + 15,
        formaFinal:    D + 16,
        equipChegou:   D + 17,
        nfFinal:       D + 18,
        dataFinal:     D + 19,
        cfopFinal:     D + 20,
        valorFinal:    D + 21,
        pedidoVenda:   D + 22,
        cobranca1:     D + 23,
        cobranca2:     D + 24
      };

      const linhas = [];
      const erros = [];
      const ROTULOS_NAO_DADOS = /^(atualizado|responsavel|total|legenda|obs|observa|verde|amarelo|vermelho|gnatus|controle de equipamentos)/i;
      const PARECE_DATA_TXT = /^\d{2}\/\d{2}\/\d{4}|^\d{4}-\d{2}-\d{2}|^\w{3} \w{3} \d{1,2} \d{4}/;

      for (let r = layout.dataInicio; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        // Filtros de linha-nao-dado: destinatario vazio, Date solto, rotulos
        const colDest = row.getCell(COL.destinatario).value;
        if (colDest instanceof Date) continue;
        const destinatario = trim(colDest);
        if (!destinatario) continue;
        if (ROTULOS_NAO_DADOS.test(destinatario)) continue;
        if (PARECE_DATA_TXT.test(destinatario)) continue;

        const item = {
          linha_excel: r,
          destinatario_nome: destinatario,
          atualizado_em_planilha: COL.atualizado ? toISODate(row.getCell(COL.atualizado).value) : null,
          novo_vencimento_obs:    COL.novoVenc   ? trim(row.getCell(COL.novoVenc).value)        : null,
          pedido_protheus:   trim(row.getCell(COL.pedido).value),
          solicitante_nome:  trim(row.getCell(COL.solicitante).value),
          responsavel_nome:  trim(row.getCell(COL.responsavel).value),
          produtos:          trim(row.getCell(COL.produtos).value),
          finalidade:        trim(row.getCell(COL.finalidade).value),
          ultima_validacao:  trim(row.getCell(COL.ultValidacao).value),
          prazo_dias:        toNumber(row.getCell(COL.prazoDias).value),
          nf_saida:          trim(row.getCell(COL.nfSaida).value),
          cfop_saida:        trim(row.getCell(COL.cfop).value),
          natureza_operacao: trim(row.getCell(COL.natureza).value),
          contrato_comodato: toBool(row.getCell(COL.contrato).value),
          valor:             toNumber(row.getCell(COL.valor).value),
          data_emissao_nf:   toISODate(row.getCell(COL.dataEmissao).value),
          data_expedicao:    toISODate(row.getCell(COL.dataExpedicao).value),
          data_vencimento:   toISODate(row.getCell(COL.dataVencto).value),
          forma_finalizacao: normalizarForma(row.getCell(COL.formaFinal).value),
          equipamento_chegou: toBool(row.getCell(COL.equipChegou).value),
          nf_finalizacao:    trim(row.getCell(COL.nfFinal).value),
          data_finalizacao:  toISODate(row.getCell(COL.dataFinal).value),
          cfop_final:        trim(row.getCell(COL.cfopFinal).value),
          valor_venda:       toNumber(row.getCell(COL.valorFinal).value),
          pedido_venda:      trim(row.getCell(COL.pedidoVenda).value),
          cobranca_1a:       trim(row.getCell(COL.cobranca1).value),
          cobranca_2a:       trim(row.getCell(COL.cobranca2).value)
        };
        // Cobranca 1a/2a podem ser datas — tenta converter pra ISO mas mantem
        // o texto original se nao for parseavel
        const c1iso = toISODate(row.getCell(COL.cobranca1).value);
        const c2iso = toISODate(row.getCell(COL.cobranca2).value);
        if (c1iso) item.cobranca_1a = c1iso;
        if (c2iso) item.cobranca_2a = c2iso;
        linhas.push(item);
      }

      if (dryRun) {
        return res.json({
          dry_run: true,
          total_linhas_validas: linhas.length,
          layout,
          amostra: linhas.slice(0, 5),
          erros
        });
      }

      // Importacao real
      let criados = 0, ignorados = 0;
      for (const it of linhas) {
        try {
          const status = it.forma_finalizacao
            ? (it.forma_finalizacao === 'PARCIAL' ? 'PARCIAL' : 'FINALIZADO')
            : 'EM_ABERTO';

          const ins = await Pg.connectAndQuery(`
            INSERT INTO tab_pt_envio (
              destinatario_nome, pedido_protheus, solicitante_nome, responsavel_nome,
              finalidade, natureza_operacao, contrato_comodato,
              prazo_dias,
              data_emissao_nf, data_expedicao, data_vencimento,
              nf_saida, cfop_saida, valor,
              cobranca_1a, cobranca_2a,
              atualizado_em_planilha, novo_vencimento_obs,
              status, criado_por, atualizado_por, origem
            ) VALUES (
              @dest, @ped, @sol, @resp,
              @fin, @nat, @ctr,
              @praz,
              @demnf::date, @dexp::date, @dvenc::date,
              @nfs, @cfop, @valor,
              @c1, @c2,
              @attp::date, @nvobs,
              @status, @uid, @uid, 'planilha_legada'
            ) RETURNING id`,
            {
              dest: it.destinatario_nome, ped: it.pedido_protheus,
              sol: it.solicitante_nome, resp: it.responsavel_nome,
              fin: it.finalidade, nat: it.natureza_operacao, ctr: it.contrato_comodato,
              praz: it.prazo_dias,
              demnf: it.data_emissao_nf, dexp: it.data_expedicao, dvenc: it.data_vencimento,
              nfs: it.nf_saida, cfop: it.cfop_saida, valor: it.valor,
              c1: it.cobranca_1a, c2: it.cobranca_2a,
              attp: it.atualizado_em_planilha,
              nvobs: it.novo_vencimento_obs ? String(it.novo_vencimento_obs).slice(0, 200) : null,
              status, uid: user.ID
            }
          );
          const envioId = ins[0].id;

          if (it.produtos) {
            await Pg.connectAndQuery(`
              INSERT INTO tab_pt_envio_item (envio_id, produto_desc, quantidade, valor_unit, ordem)
              VALUES (@eid, @desc, 1, @vu, 0)`,
              { eid: envioId, desc: it.produtos, vu: it.valor }
            );
          }

          if (it.forma_finalizacao && it.data_finalizacao) {
            await Pg.connectAndQuery(`
              INSERT INTO tab_pt_finalizacao
                (envio_id, forma, data_finalizacao, nf_final, cfop_final,
                 pedido_venda, valor_venda, equipamento_chegou, registrado_por)
              VALUES
                (@eid, @forma, @data::date, @nf, @cfop, @pedv, @vv, @ch, @uid)`,
              {
                eid: envioId, forma: it.forma_finalizacao,
                data: it.data_finalizacao, nf: it.nf_finalizacao,
                cfop: it.cfop_final, pedv: it.pedido_venda,
                vv: it.valor_venda, ch: it.equipamento_chegou, uid: user.ID
              }
            );
          }

          criados++;
        } catch (e) {
          erros.push({ linha: it.linha_excel, destinatario: it.destinatario_nome, erro: e.message });
          ignorados++;
        }
      }

      return res.json({
        ok: true,
        criados,
        ignorados,
        total_linhas: linhas.length,
        layout,
        erros: erros.slice(0, 50)
      });
    } catch (err) {
      console.error('pt-import-excel:', err);
      return res.status(500).json({ message: 'Erro ao processar planilha: ' + err.message });
    }
  }
});
