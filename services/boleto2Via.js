// services/boleto2Via.js — regras da fila de 2ª via de boleto.
//
// A 2ª via de boleto vencido é do financeiro (decisão do usuário): tem mora,
// multa e pode exigir novo registro no banco. Esta fila é onde o pedido chega,
// venha do portal do cliente ou do próprio financeiro quando o cliente liga.

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const STATUS = ['aberta', 'em_atendimento', 'atendida', 'recusada'];
const ABERTAS = ['aberta', 'em_atendimento'];

// Dados do título vindos do espelho — é a mesma foto que o cliente viu quando
// pediu, então o financeiro atende olhando o que ele olhou.
async function tituloDoEspelho(Pg, ref) {
  const r = await Pg.connectAndQuery(
    `SELECT ref, prefixo, numero, parcela, cliente_cod, cliente_loja, cliente_doc, cliente_nome,
            vencimento, valor, saldo, situacao, tem_boleto, nosso_numero, pode_2via, motivo_2via,
            contato_telefone, contato_email
       FROM tab_portal_espelho WHERE ref = @ref`, { ref: trim(ref) });
  return r[0] || null;
}

// Cria o pedido. Idempotente por `origem_id` (portal) e protegida pelo índice
// único de um pedido aberto por título.
async function criar(Pg, dados) {
  const ref = trim(dados.ref);
  if (!ref) return { erro: 'Informe o título (ref).' };

  const esp = await tituloDoEspelho(Pg, ref);
  if (!esp) return { erro: 'Título não está no espelho do portal — gere o espelho antes.' };
  if (trim(esp.situacao) === 'pago') return { erro: 'Esse título já está pago.' };

  const jaAberta = await Pg.connectAndQuery(
    `SELECT id, status, criado_em FROM tab_boleto_2via_solicitacao
      WHERE ref = @ref AND status = ANY(@abertas::text[]) LIMIT 1`, { ref, abertas: ABERTAS });
  if (jaAberta.length) {
    return { jaExistia: true, solicitacao: jaAberta[0] };
  }

  if (trim(dados.origem_id)) {
    const dup = await Pg.connectAndQuery(
      `SELECT id, status FROM tab_boleto_2via_solicitacao WHERE origem_id = @oid LIMIT 1`,
      { oid: trim(dados.origem_id) });
    if (dup.length) return { jaExistia: true, solicitacao: dup[0] };
  }

  const hoje = new Date();
  const venc = esp.vencimento ? new Date(esp.vencimento) : null;
  const atraso = venc ? Math.floor((hoje - venc) / 86400000) : null;

  const ins = await Pg.connectAndQuery(
    `INSERT INTO tab_boleto_2via_solicitacao
      (origem, origem_id, ref, prefixo, numero, parcela, cliente_cod, cliente_loja, cliente_doc,
       cliente_nome, vencimento, valor, saldo, dias_atraso, contato, mensagem, criado_por)
     VALUES (@origem, @origem_id, @ref, @prefixo, @numero, @parcela, @cliente_cod, @cliente_loja,
             @cliente_doc, @cliente_nome, @vencimento, @valor, @saldo, @atraso, @contato, @mensagem, @por)
     RETURNING id, status, criado_em`,
    {
      origem: trim(dados.origem) || 'intranet',
      origem_id: trim(dados.origem_id) || null,
      ref,
      prefixo: trim(esp.prefixo), numero: trim(esp.numero), parcela: trim(esp.parcela),
      cliente_cod: trim(esp.cliente_cod), cliente_loja: trim(esp.cliente_loja),
      cliente_doc: soDig(esp.cliente_doc), cliente_nome: trim(esp.cliente_nome),
      vencimento: esp.vencimento, valor: N(esp.valor), saldo: N(esp.saldo), atraso,
      // Sem contato informado, usa o do cadastro: é por onde a cobrança responde.
      contato: trim(dados.contato) || trim(esp.contato_telefone) || trim(esp.contato_email) || null,
      mensagem: trim(dados.mensagem) || null,
      por: dados.por || null
    });

  return { solicitacao: { ...ins[0], ref, cliente_nome: esp.cliente_nome } };
}

// Muda o status. `atendida` e `recusada` exigem resposta — sem isso o cliente
// recebe "resolvido" sem saber o quê, e a cobrança perde o histórico.
async function atender(Pg, id, { status, resposta, novoVencimento, por }) {
  if (!STATUS.includes(status)) return { erro: `Situação inválida: ${status}.` };
  if (['atendida', 'recusada'].includes(status) && !trim(resposta)) {
    return { erro: 'Escreva o que foi feito (ou o motivo da recusa) antes de fechar o pedido.' };
  }

  const atual = await Pg.connectAndQuery(
    `SELECT id, status FROM tab_boleto_2via_solicitacao WHERE id = @id`, { id });
  if (!atual.length) return { erro: 'Pedido não encontrado.' };
  if (['atendida', 'recusada'].includes(trim(atual[0].status)) && status !== 'aberta') {
    return { erro: 'Esse pedido já foi fechado. Reabra antes de mudar.' };
  }

  const fecha = ['atendida', 'recusada'].includes(status);
  const r = await Pg.connectAndQuery(
    `UPDATE tab_boleto_2via_solicitacao
        SET status = @status,
            resposta = COALESCE(@resposta, resposta),
            novo_vencimento = COALESCE(@novoVencimento, novo_vencimento),
            atendido_por = CASE WHEN @fecha THEN @por ELSE atendido_por END,
            atendido_em  = CASE WHEN @fecha THEN NOW() ELSE atendido_em END,
            atualizado_em = NOW()
      WHERE id = @id
      RETURNING id, ref, status, cliente_nome, numero, parcela`,
    { id, status, resposta: trim(resposta) || null, novoVencimento: novoVencimento || null, fecha, por: por || null });

  return { solicitacao: r[0], de: trim(atual[0].status) };
}

module.exports = { STATUS, ABERTAS, criar, atender, tituloDoEspelho };
