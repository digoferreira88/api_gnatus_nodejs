// GET /fiscal/nfse/danfse?id=<id>
// Via imprimível (DANFSE simplificada) da NFS-e emitida, montada a partir do que a
// intranet guardou (tab_nfse_emitida + nfse_xml). NÃO é o documento oficial da
// prefeitura — é um auxiliar interno; a validade fica no portal do Barretos.
// Retorna HTML pronto pra impressão. Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const esc = (v) => trim(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCnpj = (v) => { const d = String(v || '').replace(/\D/g, '').padStart(14, '0'); return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12,14)}`; };
const fmtDataHora = (s) => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2}:\d{2})?/); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ' ' + m[4] : ''}` : trim(s); };
const acha = (xml, tag) => { const m = String(xml || '').match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, 'i')); return m ? m[1] : ''; };

module.exports = (app) => ({
  verb: 'get',
  route: '/nfse/danfse',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.query.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });

    const rows = await Pg.connectAndQuery(
      `SELECT id, serie, doc, cliente, loja, cliente_nome, valor, discriminacao, ctribnac,
              ambiente, status, nfse_chave, nfse_numero, nfse_xml, emitido_em
         FROM tab_nfse_emitida WHERE id=@id`, { id });
    if (!rows.length) return res.status(404).json({ message: 'Emissão não encontrada.' });
    const r = rows[0];
    if (trim(r.status) !== 'EMITIDA') return res.status(409).json({ message: 'Só é possível imprimir NFS-e com status EMITIDA.' });

    // Melhor esforço: nº e data de autorização vêm do XML da NFS-e; senão, do que temos.
    const numero = trim(r.nfse_numero) || acha(r.nfse_xml, 'nNFSe') || '—';
    const dataAut = fmtDataHora(acha(r.nfse_xml, 'dhProc')) || fmtDataHora(r.emitido_em) || '—';
    const isProd = trim(r.ambiente) === 'producao';
    const prestNome = trim(process.env.NFSE_PREST_NOME) || 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA';
    const prestCnpj = fmtCnpj(process.env.NFSE_CNPJ || '09609356000100');
    const prestIm = trim(process.env.NFSE_IM) || '080701000506';
    const chave = trim(r.nfse_chave);

    const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>NFS-e ${esc(r.serie)}/${esc(r.doc)} — ${esc(numero)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a2740; margin: 0; padding: 24px; background: #f4f6fa; }
  .folha { max-width: 780px; margin: 0 auto; background: #fff; border: 1px solid #d5deec; border-radius: 8px; padding: 26px 30px; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a3f82; padding-bottom: 12px; margin-bottom: 16px; }
  h1 { font-size: 1.15rem; margin: 0 0 2px; color: #1a3f82; }
  .sub { font-size: .78rem; color: #6b7a90; }
  .amb { font-size: .72rem; font-weight: 700; padding: 4px 10px; border-radius: 12px; white-space: nowrap;
         color: ${isProd ? '#1e7d4f' : '#b8860b'}; background: ${isProd ? '#eef8f2' : '#fdf6e3'}; border: 1px solid ${isProd ? '#1e7d4f' : '#b8860b'}55; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin: 14px 0; }
  .bloco { border: 1px solid #eef1f6; border-radius: 6px; padding: 10px 12px; }
  .bloco h2 { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: #8093ac; margin: 0 0 6px; }
  .campo { font-size: .86rem; margin: 2px 0; }
  .campo b { color: #3d4a5c; }
  .chave { font-family: 'Courier New', monospace; font-size: .92rem; letter-spacing: .5px; word-break: break-all; background: #f6f8fb; border: 1px dashed #b9c6dc; border-radius: 6px; padding: 8px 10px; margin-top: 4px; }
  .full { grid-column: 1 / -1; }
  .valor { font-size: 1.4rem; font-weight: 800; color: #1e7d4f; }
  .rodape { margin-top: 18px; font-size: .72rem; color: #8093ac; border-top: 1px solid #eef1f6; padding-top: 10px; }
  .barra { max-width: 780px; margin: 0 auto 14px; display: flex; gap: 8px; }
  .btn { padding: 9px 18px; background: #1e5fb5; color: #fff; border: none; border-radius: 8px; font-size: .9rem; font-weight: 600; cursor: pointer; }
  @media print { body { background: #fff; padding: 0; } .folha { border: none; border-radius: 0; } .barra { display: none; } }
</style></head>
<body>
  <div class="barra"><button class="btn" onclick="window.print()">🖨️ Imprimir</button></div>
  <div class="folha">
    <div class="top">
      <div>
        <h1>NFS-e — Documento Auxiliar</h1>
        <div class="sub">Nota de serviço ${esc(r.serie)}/${esc(r.doc)} · Padrão Nacional (Barretos)</div>
      </div>
      <span class="amb">${isProd ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO'}</span>
    </div>

    <div class="grid">
      <div class="bloco">
        <h2>Prestador</h2>
        <div class="campo">${esc(prestNome)}</div>
        <div class="campo"><b>CNPJ:</b> ${esc(prestCnpj)}</div>
        <div class="campo"><b>Inscrição Municipal:</b> ${esc(prestIm)}</div>
      </div>
      <div class="bloco">
        <h2>Tomador</h2>
        <div class="campo">${esc(r.cliente_nome) || '—'}</div>
        <div class="campo"><b>Cód. Protheus:</b> ${esc(r.cliente)}/${esc(r.loja)}</div>
      </div>

      <div class="bloco full">
        <h2>Serviço</h2>
        <div class="campo">${esc(r.discriminacao) || '—'}</div>
        <div class="campo"><b>Cód. Tributação Nacional:</b> ${esc(r.ctribnac) || '—'}</div>
      </div>

      <div class="bloco">
        <h2>NFS-e</h2>
        <div class="campo"><b>Número:</b> ${esc(numero)}</div>
        <div class="campo"><b>Autorização:</b> ${esc(dataAut)}</div>
      </div>
      <div class="bloco">
        <h2>Valor do serviço</h2>
        <div class="valor">${esc(money(r.valor))}</div>
      </div>

      <div class="bloco full">
        <h2>Chave de acesso</h2>
        <div class="chave">${esc(chave) || '—'}</div>
      </div>
    </div>

    <div class="rodape">
      Documento auxiliar gerado pela intranet Gnatus em ${esc(fmtDataHora(new Date().toISOString()))}. Não substitui a
      NFS-e oficial — a nota e sua validade estão no portal da Prefeitura de Barretos (consulte pela chave de acesso).
    </div>
  </div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }
});
