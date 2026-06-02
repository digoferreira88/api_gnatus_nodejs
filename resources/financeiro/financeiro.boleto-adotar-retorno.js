// POST /financeiro/boleto-adotar-retorno
// Body: { conteudo_base64, banco, agencia, conta, simular? }
//
// Registra titulos a partir do ARQUIVO DE RETORNO (.RET) do Santander — caminho
// 100% intranet, SEM depender do Diego gravar no Protheus.
//
// Contexto: o importar-retorno do Diego nao casa o titulo Santander (procura por
// E1_NUMBCO, que esta vazio — e' justamente o retorno que deveria preenche-lo) e
// devolve tudo NAO_LOCALIZADO. Mas o NOSSO NUMERO atribuido pelo banco ESTA no
// .RET, e a intranet ja calcula a linha digitavel localmente. Entao lemos o
// nosso numero do arquivo e gravamos na propria base -> o boleto fica disparavel.
//
// Acao principal = BACKFILL: os titulos normalmente ja foram curados num lote
// (status_banco='PENDENTE', nosso_numero vazio). Para cada entrada confirmada
// (ocorrencia '02') do .RET, atualizamos a linha de retorno correspondente:
// seta nosso_numero (do arquivo) e status_banco='REGISTRADO'. Titulos do .RET
// que nao estejam em lote algum sao listados como "orfaos" (nao criamos lote
// novo aqui — use a aba de curadoria + adotar; raro).
//
// simular:true (default) -> so mostra o que SERIA atualizado, nao grava.
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const Cnab = require('../../services/cnabRetornoFiltro');

const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-adotar-retorno',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const conteudoBase64 = trim(req.body?.conteudo_base64);
    const banco = trim(req.body?.banco) || '033';
    const simular = req.body?.simular !== false;

    if (!conteudoBase64) return res.status(400).json({ message: 'Envie o conteudo do arquivo (.RET) em conteudo_base64.' });
    if (banco !== '033') return res.status(400).json({ message: 'Por enquanto so Santander (033) e suportado neste fluxo.' });

    try {
      const texto = Buffer.from(conteudoBase64, 'base64').toString('latin1');
      const detalhes = Cnab.parseDetalhes(texto);
      // Entrada confirmada (02) com nosso numero atribuido
      const confirmados = detalhes.filter(d => d.ocorrencia === '02' && d.nossoNumero && d.nossoNumero !== '00000000');
      if (!confirmados.length) {
        return res.json({ ok: true, atualizados: 0, candidatos: 0, mensagem: 'Nenhuma entrada confirmada (02) com nosso numero no arquivo.' });
      }
      // mapa chave (prefixo|numero|parcela) -> nosso numero
      const nossoPorChave = new Map();
      confirmados.forEach(d => nossoPorChave.set(`${d.prefixo}|${d.numero}|${d.parcela}`, d.nossoNumero));

      // Guard (titulo ja baixado) + borderô (E1_NUMBOR) por chave. O borderô
      // vai pro tab_boleto_envio_lote_retorno.bordero_protheus pra a tela de
      // Disparar poder filtrar por borderô.
      const baixados = new Set();
      const numborPorChave = new Map();
      const BATCH = 80;
      for (let b = 0; b < confirmados.length; b += BATCH) {
        const slice = confirmados.slice(b, b + BATCH); const p = {};
        const ors = slice.map((t, j) => { p[`pf${j}`]=t.prefixo;p[`nu${j}`]=t.numero;p[`pa${j}`]=t.parcela;
          return `(RTRIM(E1_PREFIXO)=@pf${j} AND RTRIM(E1_NUM)=@nu${j} AND RTRIM(E1_PARCELA)=@pa${j})`; }).join(' OR ');
        const rows = await Protheus.connectAndQuery(`
          SELECT RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela,
                 RTRIM(E1_STATUS) status, RTRIM(E1_BAIXA) baixa, RTRIM(E1_NUMBOR) numbor
            FROM SE1010 WITH (NOLOCK) WHERE D_E_L_E_T_<>'*' AND E1_FILIAL='01' AND (${ors})`, p);
        rows.forEach(r => {
          const k = `${trim(r.prefixo)}|${trim(r.numero)}|${trim(r.parcela)}`;
          if (trim(r.status)==='B' || trim(r.baixa).length>=8) baixados.add(k);
          if (trim(r.numbor)) numborPorChave.set(k, trim(r.numbor));
        });
      }

      // Linhas de retorno existentes que casam com as chaves do .RET
      const keys = [...nossoPorChave.keys()];
      const existentes = [];
      for (let b = 0; b < keys.length; b += BATCH) {
        const slice = keys.slice(b, b + BATCH); const p = {};
        const ors = slice.map((k, i) => { const [pf, nu, pa] = k.split('|'); p[`pf${i}`]=pf;p[`nu${i}`]=nu;p[`pa${i}`]=pa;
          return `(COALESCE(TRIM(prefixo),'')=@pf${i} AND TRIM(numero)=@nu${i} AND COALESCE(TRIM(parcela),'')=@pa${i})`; }).join(' OR ');
        const rows = await Pg.connectAndQuery(`
          SELECT id, id_lote, COALESCE(TRIM(prefixo),'') prefixo, TRIM(numero) numero, COALESCE(TRIM(parcela),'') parcela,
                 status_banco, COALESCE(TRIM(nosso_numero),'') nosso_numero, COALESCE(TRIM(bordero_protheus),'') bordero_protheus
            FROM tab_boleto_envio_lote_retorno WHERE ${ors}`, p);
        rows.forEach(r => existentes.push(r));
      }
      const existentesPorChave = new Map();
      existentes.forEach(r => {
        const k = `${trim(r.prefixo)}|${trim(r.numero)}|${trim(r.parcela)}`;
        if (!existentesPorChave.has(k)) existentesPorChave.set(k, []);
        existentesPorChave.get(k).push(r);
      });

      // Classifica. Atualiza se: PENDENTE, ou sem nosso numero, ou sem borderô
      // (este ultimo permite backfill do borderô em titulos ja registrados).
      const aAtualizar = [];   // {id, id_lote, nosso, numbor}
      let jaOk = 0, baixadoSkip = 0;
      const orfaos = [];
      for (const [k, nosso] of nossoPorChave.entries()) {
        if (baixados.has(k)) { baixadoSkip++; continue; }
        const rows = existentesPorChave.get(k);
        if (!rows || !rows.length) { orfaos.push(k); continue; }
        const numbor = numborPorChave.get(k) || '';
        const pend = rows.find(r =>
          trim(r.status_banco) !== 'REGISTRADO' || !trim(r.nosso_numero) ||
          (numbor && !trim(r.bordero_protheus)));
        if (pend) aAtualizar.push({ id: pend.id, id_lote: pend.id_lote, nosso, numbor });
        else jaOk++;
      }

      const resumo = {
        candidatos: confirmados.length,
        a_atualizar: aAtualizar.length,
        ja_registrados: jaOk,
        ja_baixados: baixadoSkip,
        orfaos: orfaos.length
      };

      if (simular) {
        return res.json({ ok: true, simular: true, ...resumo,
          mensagem: `${aAtualizar.length} título(s) seriam registrados (nosso número do .RET) e ficariam disparáveis. ${orfaos.length} órfão(s) (não estão em lote).` });
      }

      if (!aAtualizar.length) {
        return res.json({ ok: true, simular: false, atualizados: 0, ...resumo, mensagem: 'Nada novo a registrar.' });
      }

      // Backfill: seta nosso_numero + REGISTRADO nas linhas pendentes
      const lotesTocados = new Set();
      for (const u of aAtualizar) {
        await Pg.connectAndQuery(`
          UPDATE tab_boleto_envio_lote_retorno
             SET nosso_numero = @nn, status_banco = 'REGISTRADO',
                 ocorrencia_cod = '02', ocorrencia_desc = 'Entrada confirmada (.RET lido pela intranet)',
                 bordero_protheus = COALESCE(NULLIF(@bord, ''), bordero_protheus)
           WHERE id = @id`, { id: u.id, nn: u.nosso, bord: u.numbor || '' });
        lotesTocados.add(u.id_lote);
      }
      // Atualiza status dos lotes tocados pra RETORNADO se nao houver mais PENDENTE
      for (const idLote of lotesTocados) {
        await Pg.connectAndQuery(`
          UPDATE tab_boleto_envio_lote
             SET status = 'RETORNADO', sincronizado_em = NOW(),
                 qt_registrados = (SELECT COUNT(*) FROM tab_boleto_envio_lote_retorno WHERE id_lote = @id AND status_banco = 'REGISTRADO')
           WHERE id = @id
             AND NOT EXISTS (SELECT 1 FROM tab_boleto_envio_lote_retorno WHERE id_lote = @id AND status_banco = 'PENDENTE')`,
          { id: idLote });
      }

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'ADOTAR_RETORNO', severidade: 'CRITICO', req,
        entidade: 'lote', entidadeId: [...lotesTocados].join(','),
        descricao: `Registrou ${aAtualizar.length} título(s) do retorno Santander pelo nosso número do .RET (sem Protheus). Lotes: ${[...lotesTocados].join(',')}`,
        meta: { banco, ...resumo, lotes: [...lotesTocados] }
      });

      return res.json({ ok: true, simular: false, atualizados: aAtualizar.length, lotes: [...lotesTocados], ...resumo,
        mensagem: `${aAtualizar.length} título(s) registrado(s) pelo .RET. Já aparecem em "Disparar boletos".` });
    } catch (err) {
      console.error('boleto-adotar-retorno:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
