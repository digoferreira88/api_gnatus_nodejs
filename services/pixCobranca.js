// services/pixCobranca.js — Pix dos títulos sem boleto.
//
// 84% do saldo em aberto não tem boleto gerado; para esses títulos não existe
// 2ª via para baixar, e o caminho é o Pix.
//
// O cliente pede no portal, a cobrança nasce AQUI (a credencial do banco nunca
// sai da rede interna) e o QR volta para o portal na passada seguinte do
// publicador. Quando o Pix cai, a conciliação é pelo `txid`: perguntamos ao
// banco com `GET /pix`, em vez de abrir um webhook para a internet.
//
// Encargos: usamos `cobv` (cobrança com vencimento) e mandamos os PERCENTUAIS —
// quem calcula o valor final no ato do pagamento é o banco (decisão do usuário,
// 30/10). Por isso aqui não se soma multa nem juros: o que gravamos é o valor
// original e o que efetivamente entrou.
//
// A baixa no Protheus continua humana. Isto aqui enche a fila; quem dá baixa é
// o financeiro, pelo FINA070.

const BB = require('./bbPix');
const QRCode = require('qrcode');

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Encargos do título vencido. Os mesmos da planilha que a cobrança confere:
// multa 2% e juros 1% ao mês. Configuráveis porque contrato pode mudar.
const MULTA_PERC = N(process.env.PIX_MULTA_PERC) || 2;
const JUROS_PERC = N(process.env.PIX_JUROS_PERC) || 1;
// Depois disso o banco recusa o pagamento e a cobrança morre. 60 dias cobre o
// cliente que guarda o QR para pagar "na semana que vem".
const VALIDADE_DIAS = Number(process.env.PIX_VALIDADE_DIAS) || 60;

const hoje = () => diaIso(new Date());

// O Postgres devolve DATE como objeto Date, e o Protheus devolve texto. Tratar
// os dois como string dava "Wed Oct 2" no lugar da data — e isso ia para o
// banco dentro da cobrança.
function diaIso(v) {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}

// --------------------------------------------------------------- criação
// Cria a cobrança de um título do espelho. Idempotente duas vezes: pelo
// `origem_id` (o mesmo pedido do portal chegando de novo) e pela cobrança viva
// do título (pedir outra vez devolve a que já existe, em vez de espalhar QR
// Codes diferentes do mesmo título por aí).
async function criar(app, { ref, origem, origemId }) {
  const { Pg } = app.services;

  if (trim(origemId)) {
    const dup = await Pg.connectAndQuery(
      `SELECT * FROM tab_pix_cobranca WHERE origem_id = @oid LIMIT 1`, { oid: trim(origemId) });
    if (dup.length) return { jaExistia: true, cobranca: dup[0] };
  }

  const viva = await Pg.connectAndQuery(
    `SELECT * FROM tab_pix_cobranca
      WHERE ref = @ref AND status IN ('criando', 'ativa')
        AND (expira_em IS NULL OR expira_em > NOW()) LIMIT 1`, { ref: trim(ref) });
  if (viva.length) return { jaExistia: true, cobranca: viva[0] };

  const esp = await Pg.connectAndQuery(
    `SELECT ref, prefixo, numero, parcela, cliente_cod, cliente_loja, cliente_doc, cliente_nome,
            vencimento, valor, saldo, situacao, tem_boleto, pode_2via
       FROM tab_portal_espelho WHERE ref = @ref`, { ref: trim(ref) });
  if (!esp.length) return { erro: 'Título não está no espelho do portal.' };

  const t = esp[0];
  if (trim(t.situacao) === 'pago') return { erro: 'Esse título já está pago.' };
  if (N(t.saldo) <= 0) return { erro: 'Esse título não tem saldo em aberto.' };
  // Quem tem boleto registrado paga pelo boleto: dois caminhos para o mesmo
  // título é receber duas vezes e ter de devolver uma.
  if (t.tem_boleto) return { erro: 'Esse título tem boleto registrado — o pagamento é pelo boleto.' };

  const doc = soDig(t.cliente_doc);
  if (doc.length !== 11 && doc.length !== 14) return { erro: 'Cliente sem CPF/CNPJ válido no cadastro.' };

  const vencimento = diaIso(t.vencimento);
  if (!vencimento) return { erro: 'Título sem data de vencimento utilizável.' };
  // Título em dia não leva encargo nenhum. Guardamos o que vai ao banco, não a
  // configuração: senão a tela do cliente avisa sobre multa que não existe.
  const venceu = vencimento < hoje();
  const multa = venceu ? MULTA_PERC : 0;
  const juros = venceu ? JUROS_PERC : 0;

  const txid = BB.novoTxid({ numero: t.numero, parcela: t.parcela });
  // Grava ANTES de chamar o banco: se a chamada falhar no meio, a linha fica
  // com o erro e dá para investigar. Cobrança criada no BB sem registro aqui
  // seria dinheiro entrando sem ninguém saber de quem é.
  const ins = await Pg.connectAndQuery(
    `INSERT INTO tab_pix_cobranca
      (txid, ref, origem, origem_id, cliente_doc, cliente_cod, cliente_loja, cliente_nome,
       prefixo, numero, parcela, valor_original, vencimento, multa_perc, juros_perc, status)
     VALUES (@txid, @ref, @origem, @origemId, @doc, @cod, @loja, @nome,
             @prefixo, @numero, @parcela, @valor, @vencimento, @multa, @juros, 'criando')
     RETURNING *`,
    {
      txid, ref: trim(ref), origem: trim(origem) || 'portal', origemId: trim(origemId) || null,
      doc, cod: trim(t.cliente_cod), loja: trim(t.cliente_loja), nome: trim(t.cliente_nome),
      prefixo: trim(t.prefixo), numero: trim(t.numero), parcela: trim(t.parcela),
      valor: N(t.saldo), vencimento,
      multa, juros
    });

  try {
    const r = await BB.criarCobv({
      txid,
      valor: N(t.saldo),
      vencimento,
      validadeDias: VALIDADE_DIAS,
      devedor: doc.length === 14
        ? { cnpj: doc, nome: trim(t.cliente_nome) }
        : { cpf: doc, nome: trim(t.cliente_nome) },
      descricao: `Gnatus - NF ${trim(t.numero)}${trim(t.parcela) ? '/' + trim(t.parcela) : ''}`,
      // Vencido leva multa e juros, que o banco aplica sozinho a partir da data
      // de vencimento; em dia vai zero.
      multaPerc: multa,
      jurosPerc: juros
    });

    const copiaECola = trim(r.pixCopiaECola);
    const qr = copiaECola
      ? (await QRCode.toDataURL(copiaECola, { margin: 1, width: 360 })).replace(/^data:image\/png;base64,/, '')
      : null;

    const upd = await Pg.connectAndQuery(
      `UPDATE tab_pix_cobranca
          SET status = 'ativa', copia_e_cola = @copia, qr_png = @qr, location = @loc, loc_id = @locId,
              expira_em = @expira, erro = NULL, atualizado_em = NOW(), publicado_em = NULL
        WHERE txid = @txid RETURNING *`,
      {
        txid, copia: copiaECola || null, qr,
        loc: trim(r.loc?.location) || null,
        locId: r.loc?.id != null ? Number(r.loc.id) : null,
        // A cobv vale até `validadeAposVencimento` dias depois do vencimento.
        expira: new Date(new Date(vencimento + 'T12:00:00Z').getTime() + VALIDADE_DIAS * 86400000)
      });
    return { cobranca: upd[0] };
  } catch (e) {
    await Pg.connectAndQuery(
      `UPDATE tab_pix_cobranca SET status = 'erro', erro = @erro, atualizado_em = NOW(), publicado_em = NULL
        WHERE txid = @txid`, { txid, erro: e.message.slice(0, 500) });
    console.error('pixCobranca: BB recusou a cobrança —', e.message);
    return { erro: 'Não foi possível gerar o Pix agora.', detalhe: e.message };
  }
}

// ----------------------------------------------------------- conciliação
// Pergunta ao banco quais Pix caíram e casa pelo txid. Roda sozinha no
// scheduler; a janela sobreposta cobre o Pix que cai entre duas passadas.
async function conciliar(app, { minutos } = {}) {
  const { Pg } = app.services;
  if (!BB.configurado()) return { status: 'inerte', novos: 0 };

  const janela = Number(minutos) || Number(process.env.PIX_JANELA_MIN) || 30;
  const fim = new Date();
  const inicio = new Date(fim.getTime() - janela * 60000);

  let pagina = 0, paginas = 1, vistos = 0, semDono = 0;
  const novos = [];
  while (pagina < paginas && pagina < 20) {
    const r = await BB.listarRecebidos({ inicio, fim, pagina });
    const lista = Array.isArray(r?.pix) ? r.pix : [];
    paginas = Number(r?.parametros?.paginacao?.quantidadeDePaginas) || 1;
    vistos += lista.length;

    for (const p of lista) {
      const txid = trim(p.txid);
      if (!txid) continue;   // Pix avulso, sem cobrança nossa — não é nosso assunto
      const upd = await Pg.connectAndQuery(
        `UPDATE tab_pix_cobranca
            SET status = 'paga', e2eid = @e2e, valor_pago = @valor, pago_em = @em,
                pagador_nome = @pagNome, pagador_doc = @pagDoc,
                atualizado_em = NOW(), publicado_em = NULL
          WHERE txid = @txid AND status <> 'paga'
          RETURNING id, ref, numero, cliente_nome, valor_pago`,
        {
          txid, e2e: trim(p.endToEndId).slice(0, 32), valor: N(p.valor),
          em: p.horario ? new Date(p.horario) : new Date(),
          pagNome: trim(p.pagador?.nome).slice(0, 200) || null,
          pagDoc: soDig(p.pagador?.cnpj || p.pagador?.cpf) || null
        });
      if (upd.length) {
        novos.push(upd[0]);
        console.log(`[pix] recebido: NF ${upd[0].numero} · R$ ${N(upd[0].valor_pago).toFixed(2)} · ${upd[0].cliente_nome}`);
      } else {
        semDono++;   // já conciliado antes, ou txid de outra origem
      }
    }
    pagina++;
  }

  if (novos.length) await avisarFinanceiro(novos);
  return { status: 'ok', vistos, novos: novos.length, repetidos: semDono, janela };
}

// O financeiro precisa saber que entrou dinheiro para ir baixar — a fila na
// tela só ajuda quem está olhando para ela.
async function avisarFinanceiro(novos) {
  const para = trim(process.env.PIX_AVISO_EMAIL) || 'cobranca@gnatus.com.br';
  const total = novos.reduce((s, p) => s + N(p.valor_pago), 0);
  const linhas = novos.map(p =>
    `  NF ${trim(p.numero)} — ${trim(p.cliente_nome)} — R$ ${N(p.valor_pago).toFixed(2)}`).join('\n');
  try {
    const Email = require('./emailService');
    await Email.sendEmail({
      to: para,
      subject: `Pix recebido: ${novos.length} título(s) — R$ ${total.toFixed(2)}`,
      text: [
        `Entraram ${novos.length} pagamento(s) por Pix do portal do cliente:`,
        '',
        linhas,
        '',
        `Total: R$ ${total.toFixed(2)}`,
        '',
        'Os títulos estão em Financeiro > Recebimentos Pix, esperando a baixa no Protheus.',
        'Depois de baixar, marque na tela para sair da fila.'
      ].join('\n')
    });
  } catch (e) {
    // Dinheiro já entrou e está registrado; falhar o aviso não pode desfazer a
    // conciliação.
    console.warn('[pix] aviso ao financeiro falhou:', e.message);
  }
}

// Marca o que o financeiro já baixou no Protheus. A baixa em si é humana
// (decisão do usuário): aqui só guardamos quem conferiu e quando.
async function marcarBaixado(app, { id, por, obs }) {
  const { Pg } = app.services;
  const r = await Pg.connectAndQuery(
    `UPDATE tab_pix_cobranca
        SET baixado_em = NOW(), baixado_por = @por, baixa_obs = @obs, atualizado_em = NOW()
      WHERE id = @id AND status = 'paga' AND baixado_em IS NULL
      RETURNING id, ref, numero, valor_pago`, { id: Number(id), por: por || null, obs: trim(obs) || null });
  if (!r.length) return { erro: 'Recebimento não encontrado, ainda não pago ou já baixado.' };
  return { cobranca: r[0] };
}

// Cobranças que o banco não vai mais aceitar. Fecha a porta para o cliente
// pagar um QR velho de um título que mudou de valor.
async function expirarVencidas(app) {
  const { Pg } = app.services;
  const r = await Pg.connectAndQuery(
    `UPDATE tab_pix_cobranca SET status = 'expirada', atualizado_em = NOW(), publicado_em = NULL
      WHERE status = 'ativa' AND expira_em IS NOT NULL AND expira_em < NOW()
      RETURNING id`, {});
  return { expiradas: r.length };
}

module.exports = {
  criar, conciliar, marcarBaixado, expirarVencidas, avisarFinanceiro,
  MULTA_PERC, JUROS_PERC, VALIDADE_DIAS
};
