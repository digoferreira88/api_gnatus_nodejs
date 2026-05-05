// POST /controladoria/pt/import-excel — importa planilha legada de Poder de Terceiros.
// Multipart: campo 'arquivo' = .xlsx
// Query: ?dry=true → so valida e retorna preview (nao grava)
//
// Estrutura esperada (colunas pela ORDEM, baseado na planilha do fiscal):
//   A=destinatario  B=pedido  C=solicitante  D=responsavel  E=produtos
//   F=finalidade    G=ult.validacao  H=prazo_dias  I=nf_saida  J=cfop_saida
//   K=natureza      L=contrato_comodato  M=valor  N=data_emissao  O=data_expedicao
//   P=data_vencimento  Q=forma_finalizacao  R=equipamento_chegou
//   S=nf_finalizacao  T=data_finalizacao  U=cfop_final  V=valor_venda
//   W=pedido_venda   X=cobranca_1a  Y=cobranca_2a
//
// Linha de cabecalho esta na linha 6. Dados comecam na linha 7.
//
// Permissao 11003.

const ExcelJS = require('exceljs');
const multer = require('multer');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const trim = (v) => v == null ? null : (typeof v === 'string' ? v.trim() : String(v).trim()) || null;

// Excel armazena datas como Date object OU como serial. Tenta normalizar.
function toISODate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  // numero serial Excel (dias desde 1900-01-00)
  if (typeof v === 'number') {
    const ms = (v - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  // string YYYY-MM-DD ou DD/MM/YYYY
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in v) return Number(v.result) || null;
  const s = String(v).replace(/[R$\s.]/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toBool(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toUpperCase();
  if (['SIM','S','TRUE','1','YES','Y'].includes(s)) return true;
  if (['NAO','NÃO','N','FALSE','0','NO'].includes(s)) return false;
  return null;
}

const FORMAS_VALIDAS = ['RETORNO','PARCIAL','VENDA','RENOVACAO','TROCA'];
function normalizarForma(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');  // remove acentos
  if (FORMAS_VALIDAS.includes(s)) return s;
  if (s.includes('RETORN')) return 'RETORNO';
  if (s.includes('VENDA')) return 'VENDA';
  if (s.includes('RENOV')) return 'RENOVACAO';
  if (s.includes('TROC')) return 'TROCA';
  if (s.includes('PARCIAL')) return 'PARCIAL';
  return null;
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
      const ws = wb.worksheets[0];

      const linhas = [];
      const erros = [];
      // Detecta inicio dos dados: procura "DESTINATARIO" no header (col A)
      // e usa linha+1 como inicio.
      let linhaInicio = 7;
      for (let r = 1; r <= 10; r++) {
        const v = ws.getRow(r).getCell(1).value;
        if (typeof v === 'string' && v.trim().toUpperCase() === 'DESTINATARIO') {
          linhaInicio = r + 1;
          break;
        }
      }

      for (let r = linhaInicio; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const destinatario = trim(row.getCell(1).value);
        if (!destinatario) continue;  // pula vazias

        const item = {
          linha_excel: r,
          destinatario_nome: destinatario,
          pedido_protheus: trim(row.getCell(2).value),
          solicitante_nome: trim(row.getCell(3).value),
          responsavel_nome: trim(row.getCell(4).value),
          produtos: trim(row.getCell(5).value),
          finalidade: trim(row.getCell(6).value),
          ultima_validacao: trim(row.getCell(7).value),
          prazo_dias: toNumber(row.getCell(8).value),
          nf_saida: trim(row.getCell(9).value),
          cfop_saida: trim(row.getCell(10).value),
          natureza_operacao: trim(row.getCell(11).value),
          contrato_comodato: toBool(row.getCell(12).value),
          valor: toNumber(row.getCell(13).value),
          data_emissao_nf: toISODate(row.getCell(14).value),
          data_expedicao: toISODate(row.getCell(15).value),
          data_vencimento: toISODate(row.getCell(16).value),
          forma_finalizacao: normalizarForma(row.getCell(17).value),
          equipamento_chegou: toBool(row.getCell(18).value),
          nf_finalizacao: trim(row.getCell(19).value),
          data_finalizacao: toISODate(row.getCell(20).value),
          cfop_final: trim(row.getCell(21).value),
          valor_venda: toNumber(row.getCell(22).value),
          pedido_venda: trim(row.getCell(23).value),
          cobranca_1a: trim(row.getCell(24).value),
          cobranca_2a: trim(row.getCell(25).value)
        };
        // Cobranca 1a/2a podem ser datas — tenta converter pra ISO mas mantem texto se nao for
        const c1iso = toISODate(row.getCell(24).value);
        const c2iso = toISODate(row.getCell(25).value);
        if (c1iso) item.cobranca_1a = c1iso;
        if (c2iso) item.cobranca_2a = c2iso;
        linhas.push(item);
      }

      if (dryRun) {
        return res.json({
          dry_run: true,
          total_linhas_validas: linhas.length,
          linhaInicio,
          amostra: linhas.slice(0, 5),
          erros
        });
      }

      // Importacao real
      let criados = 0, ignorados = 0;
      for (const it of linhas) {
        try {
          // Calcula status: se tem forma_finalizacao -> FINALIZADO ou PARCIAL
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
              status, criado_por, atualizado_por, origem
            ) VALUES (
              @dest, @ped, @sol, @resp,
              @fin, @nat, @ctr,
              @praz,
              @demnf::date, @dexp::date, @dvenc::date,
              @nfs, @cfop, @valor,
              @c1, @c2,
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
              status, uid: user.ID
            }
          );
          const envioId = ins[0].id;

          // Item unico texto livre da coluna E (Produtos)
          if (it.produtos) {
            await Pg.connectAndQuery(`
              INSERT INTO tab_pt_envio_item (envio_id, produto_desc, quantidade, valor_unit, ordem)
              VALUES (@eid, @desc, 1, @vu, 0)`,
              { eid: envioId, desc: it.produtos, vu: it.valor }
            );
          }

          // Se ha finalizacao, registra
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
        linhaInicio,
        erros: erros.slice(0, 50)
      });
    } catch (err) {
      console.error('pt-import-excel:', err);
      return res.status(500).json({ message: 'Erro ao processar planilha: ' + err.message });
    }
  }
});
