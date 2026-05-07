// services/telefoniaImport.js
// Parser do XLSX da telefonia movel ("Gnatus_Linhas_Telefonia Movel.xlsx").
//
// Estrutura observada do arquivo:
//   - Cada aba = 1 operadora (Claro, Tim, Vivo...).
//   - Dentro de cada aba podem existir VARIAS contas separadas por blocos.
//     Cada bloco comeca com:
//        R0:  "NºConta: XXXXX | NºCliente: YYYYY"
//        R1:  "GNATUS PRODUTOS M E ODONTOLOGICOS LTDA - N acessos"
//        R2:  Header das colunas (Plano | (Ativacao)? | Vencimento | Nº | Pessoa | Departamento | (GB)? | (+)? | (-)?)
//        R3+: dados ate proxima linha "NºConta:" ou fim
//   - Claro tem coluna "GB" (franquia) e flags "+/-" (provavelmente indicador
//     de pedido de upgrade/downgrade — guardamos em observacoes se preenchidos).
//   - Tim tem "Ativacao" alem de "Vencimento" (Claro nao tem ativacao).
//
// Saida do parse:
//   { contas: [{ operadora, numeroConta, numeroCliente, razaoSocial, linhas: [...] }],
//     departamentos: Set<string>, totais: { abas, contas, linhas } }

const ExcelJS = require('exceljs');

const trim = (v) => String(v == null ? '' : v).trim();

const cellText = (c) => {
  if (!c) return '';
  let v = c.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v.richText) return v.richText.map(r => r.text).join('');
    if (v.hyperlink) return String(v.text || v.hyperlink);
  }
  return String(v);
};

const cellDate = (c) => {
  if (!c) return null;
  const v = c.value;
  if (v instanceof Date) return v;
  if (typeof v === 'object' && v && v.result instanceof Date) return v.result;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
    const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return new Date(br[3] + '-' + br[2] + '-' + br[1] + 'T00:00:00Z');
  }
  return null;
};

// Limpa numero de telefone — mantem so digitos, despreza zeros a esquerda redundantes
const normNumero = (v) => {
  const s = trim(v).replace(/\D/g, '');
  return s.length >= 8 ? s : null;
};

// "Claro Pos Individual 6GB" -> 6
// "Tim Black Empresa III-SP 30GB" -> 30
// "Claro Pos Individual 6GB + Passaporte Mundo 10GB" -> 6  (pega o primeiro do plano-base)
const extrairFranquiaGb = (plano) => {
  const m = String(plano || '').match(/(\d+(?:[.,]\d+)?)\s*GB/i);
  return m ? Number(m[1].replace(',', '.')) : null;
};

const isHeaderConta = (txt) => /N[ºo°]?\s*Conta\s*:/i.test(txt);
const isHeaderColunas = (txt) => /^(plano|ativa|vencimento|n[ºo°]?$|pessoa|departamento)$/i.test(trim(txt));
const isLinhaResumo = (txt) => /\d+\s*acessos?\s*$/i.test(txt);

// "NºConta: 154490042 | NºCliente: 145981824" -> { conta:'154490042', cliente:'145981824' }
const parseHeaderConta = (txt) => {
  const conta   = (txt.match(/N[ºo°]?\s*Conta\s*:\s*([\d.\-\/]+)/i)   || [])[1] || '';
  const cliente = (txt.match(/N[ºo°]?\s*Cliente\s*:\s*([\d.\-\/]+)/i) || [])[1] || '';
  return { conta: trim(conta), cliente: trim(cliente) };
};

// Detecta o mapeamento das colunas a partir da linha "GNATUS... N acessos".
// Nessa linha a celula 1 traz a razao social + acessos, e as celulas 2..N trazem os
// headers (Vencimento | Ativacao | Nº | Pessoa | Departamento | GB | + | -).
// Por convencao a COLUNA 1 sempre e o Plano (primeira coluna da planilha).
const detectarMapeamento = (row) => {
  const headers = [];
  row.eachCell({ includeEmpty: true }, (c, n) => {
    headers[n - 1] = trim(cellText(c))
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');  // remove acentos
  });
  const map = { plano: 0, ativacao: -1, vencimento: -1, numero: -1, pessoa: -1, departamento: -1, gb: -1, mais: -1, menos: -1 };
  headers.forEach((h, idx) => {
    if (idx === 0) return;     // coluna 1 e sempre o plano (vem com a razao social merged)
    if (h === 'plano') map.plano = idx;
    else if (h === 'ativacao') map.ativacao = idx;
    else if (h === 'vencimento') map.vencimento = idx;
    else if (h === 'no' || h === 'numero' || h === 'n' || /^n[º°]$/.test(h)) map.numero = idx;
    else if (h === 'pessoa') map.pessoa = idx;
    else if (h === 'departamento') map.departamento = idx;
    else if (h === 'gb') map.gb = idx;
    else if (h === '+') map.mais = idx;
    else if (h === '-') map.menos = idx;
  });
  return map;
};

async function parsePlanilha (filePathOrBuffer) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(filePathOrBuffer)) await wb.xlsx.load(filePathOrBuffer);
  else                                   await wb.xlsx.readFile(filePathOrBuffer);

  const contas = [];
  const departamentos = new Set();
  let totalLinhas = 0;
  let abas = 0;

  wb.eachSheet((ws) => {
    abas++;
    const operadora = trim(ws.name);
    let bloco = null;        // { conta, cliente, razaoSocial, mapping, linhas: [] }

    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cell0 = trim(cellText(row.getCell(1)));
      if (!cell0 && bloco == null) continue;

      // Inicio de novo bloco de conta
      if (isHeaderConta(cell0)) {
        if (bloco) contas.push(bloco);
        const hc = parseHeaderConta(cell0);
        bloco = { operadora, numeroConta: hc.conta, numeroCliente: hc.cliente, razaoSocial: '', mapping: null, linhas: [] };
        continue;
      }

      // Linha de resumo "GNATUS ... N acessos" — eh tambem a linha do header
      // de colunas (cell1 = razao+acessos, cells 2..N = Vencimento/Ativacao/Nº/Pessoa/...)
      if (bloco && isLinhaResumo(cell0)) {
        bloco.razaoSocial = cell0.replace(/\s*-\s*\d+\s*acessos?\s*$/i, '').trim();
        bloco.mapping = detectarMapeamento(row);
        continue;
      }

      // Caso o header venha em linha separada (variacao de planilha) — fallback
      if (bloco && !bloco.mapping && /^plano$/i.test(cell0)) {
        bloco.mapping = detectarMapeamento(row);
        continue;
      }

      // Dados
      if (bloco && bloco.mapping) {
        const m = bloco.mapping;
        const plano   = m.plano    >= 0 ? trim(cellText(row.getCell(m.plano + 1)))    : '';
        const numero  = m.numero   >= 0 ? normNumero(cellText(row.getCell(m.numero + 1))) : null;
        // Linha tem que ter PELO MENOS plano OU numero pra ser dado real
        if (!plano && !numero) continue;
        // Se plano vier vazio mas existir numero -> tudo bem; se plano existe mas vier "Plano"
        // (header repetido), descarta
        if (/^plano$/i.test(plano)) continue;

        const ativacao   = m.ativacao   >= 0 ? cellDate(row.getCell(m.ativacao + 1))   : null;
        const vencimento = m.vencimento >= 0 ? cellDate(row.getCell(m.vencimento + 1)) : null;
        const pessoa     = m.pessoa     >= 0 ? trim(cellText(row.getCell(m.pessoa + 1)))       : '';
        const departamento = m.departamento >= 0 ? trim(cellText(row.getCell(m.departamento + 1))) : '';
        const gb         = m.gb >= 0 ? Number(String(cellText(row.getCell(m.gb + 1))).replace(',', '.')) : null;
        const mais       = m.mais  >= 0 ? trim(cellText(row.getCell(m.mais + 1)))  : '';
        const menos      = m.menos >= 0 ? trim(cellText(row.getCell(m.menos + 1))) : '';

        if (departamento) departamentos.add(departamento);

        const obs = [];
        if (mais)  obs.push('Solicitacao + (upgrade): ' + mais);
        if (menos) obs.push('Solicitacao - (downgrade): ' + menos);

        bloco.linhas.push({
          plano,
          numero,
          pessoa,
          departamento,
          franquiaGb: Number.isFinite(gb) && gb > 0 ? gb : extrairFranquiaGb(plano),
          dataAtivacao: ativacao,
          dataVencimento: vencimento,
          status: pessoa ? 'Ativa' : 'EmEstoque',
          observacoes: obs.length ? obs.join(' | ') : ''
        });
        totalLinhas++;
      }
    }
    if (bloco) contas.push(bloco);
  });

  return {
    contas,
    departamentos,
    totais: { abas, contas: contas.length, linhas: totalLinhas }
  };
}

// Aplica o parse no banco — dentro de transacao, idempotente por
// (operadora, numero_telefone). Retorna estatisticas.
async function aplicarNoBanco (Pg, parsed, opts = {}) {
  const { idUsuario = null, dryRun = false } = opts;
  const stats = { contasNovas: 0, contasAtualizadas: 0, linhasNovas: 0, linhasAtualizadas: 0,
                  linhasIgnoradas: 0, departamentosNovos: 0, erros: [] };

  // 1) Garante operadoras
  for (const c of parsed.contas) {
    if (!c.operadora) continue;
    if (!dryRun) {
      await Pg.connectAndQuery(
        `INSERT INTO tab_operadora (nome) VALUES (@n) ON CONFLICT (nome) DO NOTHING`,
        { n: c.operadora }
      );
    }
  }

  // 2) Garante departamentos
  for (const dep of parsed.departamentos) {
    if (!dep) continue;
    if (!dryRun) {
      const r = await Pg.connectAndQuery(
        `INSERT INTO tab_telefonia_departamento (nome) VALUES (@n)
         ON CONFLICT (nome) DO NOTHING RETURNING id`,
        { n: dep }
      );
      if (r.length) stats.departamentosNovos++;
    }
  }

  // 3) Mapas operadora -> id e departamento -> id
  const operRows = dryRun ? [] : await Pg.connectAndQuery(`SELECT id, nome FROM tab_operadora`, {});
  const depRows  = dryRun ? [] : await Pg.connectAndQuery(`SELECT id, nome FROM tab_telefonia_departamento`, {});
  const operId = Object.fromEntries(operRows.map(r => [r.nome, r.id]));
  const depId  = Object.fromEntries(depRows.map(r => [r.nome, r.id]));

  // 4) Para cada conta + linha
  for (const c of parsed.contas) {
    const idOp = operId[c.operadora];
    if (!idOp) { stats.erros.push(`Operadora "${c.operadora}" sem id`); continue; }

    let idConta = null;
    if (c.numeroConta) {
      if (!dryRun) {
        const upsert = await Pg.connectAndQuery(`
          INSERT INTO tab_telefonia_conta (id_operadora, numero_conta, numero_cliente, razao_social)
          VALUES (@op, @nc, @ncli, @rs)
          ON CONFLICT (id_operadora, numero_conta)
          DO UPDATE SET numero_cliente = COALESCE(EXCLUDED.numero_cliente, tab_telefonia_conta.numero_cliente),
                        razao_social   = COALESCE(EXCLUDED.razao_social,   tab_telefonia_conta.razao_social)
          RETURNING id, (xmax = 0) AS inserted`,
          { op: idOp, nc: c.numeroConta, ncli: c.numeroCliente || null, rs: c.razaoSocial || null }
        );
        idConta = upsert[0]?.id || null;
        if (upsert[0]?.inserted) stats.contasNovas++; else stats.contasAtualizadas++;
      }
    }

    for (const l of c.linhas) {
      if (!l.numero) { stats.linhasIgnoradas++; continue; }

      if (dryRun) { stats.linhasNovas++; continue; }

      const idDep = l.departamento ? (depId[l.departamento] || null) : null;

      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_telefonia_linha (
          id_operadora, id_conta, id_departamento, numero_telefone,
          plano, franquia_gb, pessoa, data_ativacao, data_vencimento,
          status, observacoes
        ) VALUES (@op, @con, @dep, @num, @pl, @gb, @pes, @at, @ven, @st, @obs)
        ON CONFLICT (id_operadora, numero_telefone) DO UPDATE SET
          id_conta        = EXCLUDED.id_conta,
          id_departamento = COALESCE(EXCLUDED.id_departamento, tab_telefonia_linha.id_departamento),
          plano           = COALESCE(NULLIF(EXCLUDED.plano, ''), tab_telefonia_linha.plano),
          franquia_gb     = COALESCE(EXCLUDED.franquia_gb, tab_telefonia_linha.franquia_gb),
          pessoa          = COALESCE(NULLIF(EXCLUDED.pessoa, ''), tab_telefonia_linha.pessoa),
          data_ativacao   = COALESCE(EXCLUDED.data_ativacao, tab_telefonia_linha.data_ativacao),
          data_vencimento = COALESCE(EXCLUDED.data_vencimento, tab_telefonia_linha.data_vencimento),
          observacoes     = COALESCE(NULLIF(EXCLUDED.observacoes, ''), tab_telefonia_linha.observacoes),
          atualizado_em   = NOW()
        RETURNING id, (xmax = 0) AS inserted`,
        {
          op: idOp, con: idConta, dep: idDep, num: l.numero,
          pl: l.plano || '', gb: l.franquiaGb || null,
          pes: l.pessoa || '',
          at: l.dataAtivacao ? l.dataAtivacao.toISOString().slice(0, 10) : null,
          ven: l.dataVencimento ? l.dataVencimento.toISOString().slice(0, 10) : null,
          st: l.status || 'Ativa',
          obs: l.observacoes || ''
        }
      );

      const idLinha = r[0]?.id;
      const inserted = r[0]?.inserted;
      if (inserted) stats.linhasNovas++; else stats.linhasAtualizadas++;

      if (idLinha) {
        await Pg.connectAndQuery(`
          INSERT INTO tab_telefonia_linha_hist (id_linha, acao, depois, id_usuario, descricao)
          VALUES (@id, 'IMPORT', @dep::jsonb, @uid, @desc)`,
          {
            id: idLinha,
            dep: JSON.stringify({ plano: l.plano, pessoa: l.pessoa, departamento: l.departamento, status: l.status, observacoes: l.observacoes }),
            uid: idUsuario,
            desc: `Importado da planilha (${c.operadora}, conta ${c.numeroConta || '-'})`
          }
        );
      }
    }
  }

  return stats;
}

module.exports = { parsePlanilha, aplicarNoBanco };
