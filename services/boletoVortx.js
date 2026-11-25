// services/boletoVortx.js — banco 310 (Vortx DTVM, plataforma Grafeno): cobranca
// em garantia da DelMonte, a partir de 24/11/2026.
//
// O que e' diferente dos outros bancos:
//   - A Gnatus gera o nosso numero (E1_NUMBCO, 11 digitos, faixa do SEE 102) e
//     emite o boleto. Beneficiario = Gnatus (decisao do usuario, 24/11/2026);
//     so a conta e' a da Vortx (SA6 recno 171 "DEL MONTE").
//   - NAO HA ARQUIVO DE RETORNO: o layout da Vortx ("Banco 310 - V1.1") so tem
//     remessa. Logo nada marca o titulo como registrado (E1_OCORREN fica vazio).
//     O titulo so entra no fluxo de boletos quando o financeiro CONFIRMA o
//     borderô, depois que a DelMonte confirmar o recebimento do arquivo
//     (POST /financeiro/boleto-310-confirmar). Ate la nao sai PDF nem disparo.
//   - O campo livre leva agencia e conta COM digito. O SA6 nao tem o digito da
//     agencia (A6_DVAGE vazio): 0001-9 vem do manual e confere com o modulo 11.
//     O da conta (4) e' o A6_DVCTA. Os dois ficam aqui, com override por .env.
//
// Override por .env (sem deploy):
//   BANCO_310_AGENCIA / _AGENCIA_DV / _CONTA / _CONTA_DV / _CARTEIRA
//   BANCO_310_BORDEROS_TESTE=001523,...  (somados ao 001523 fixo)

const trim = (v) => String(v == null ? '' : v).trim();
const env = (k) => trim(process.env[k]);
const soDig = (v) => trim(v).replace(/\D/g, '');
const semZeros = (v) => soDig(v).replace(/^0+(?=\d)/, '');

const BANCO = '310';

// Borderô 001523 (19/11/2026) = arquivo de TESTE. O fundo nao aceita operacao
// de teste, entao esses 4 titulos NAO estao registrados na Vortx e o boleto
// deles nunca pode ir a cliente (handoff do Diego, 24/11/2026).
const BORDEROS_TESTE_FIXOS = ['001523'];

function config() {
  return {
    banco: BANCO,
    nome: 'Vortx DTVM',
    nomeCurto: 'Vortx',
    agencia: env('BANCO_310_AGENCIA') || '0001',
    agenciaDv: env('BANCO_310_AGENCIA_DV') || '9',
    conta: env('BANCO_310_CONTA') || '11974615',
    contaDv: env('BANCO_310_CONTA_DV') || '4',
    carteira: env('BANCO_310_CARTEIRA') || '021'
  };
}

const ehVortx = (banco) => trim(banco) === BANCO;

/**
 * Digitos da agencia/conta do 310 para o campo livre. So devolve quando a
 * agencia e a conta informadas sao as cadastradas — conta diferente = null,
 * porque o digito seria chute e a linha sairia invalida sem erro.
 */
function coordenadas({ agencia, conta } = {}) {
  const c = config();
  if (semZeros(agencia) !== semZeros(c.agencia) || semZeros(conta) !== semZeros(c.conta)) return null;
  return { agencia: c.agencia, agenciaDv: c.agenciaDv, conta: c.conta, contaDv: c.contaDv, carteira: c.carteira };
}

/**
 * Dados efetivos do boleto (mesmo formato do PortadorCessao.dadosBoleto), com o
 * layout da ficha: "Agencia / Cod. Beneficiario" = 0001-9/11974615-4 (manual,
 * p. 24) e carteira impressa 21 (a do nosso numero).
 */
function dadosBoleto({ agencia, conta } = {}) {
  const c = config();
  return {
    banco: BANCO,
    agencia: trim(agencia) || c.agencia,
    conta: trim(conta) || c.conta,
    carteira: c.carteira,
    cessao: false,
    pdf: {
      agenciaImpressa: `${c.agencia}-${c.agenciaDv}`,
      codigoBeneficiario: `${c.conta}-${c.contaDv}`,
      carteiraImpressa: String(Number(c.carteira))
    }
  };
}

function borderosTeste() {
  return new Set([...BORDEROS_TESTE_FIXOS, ...env('BANCO_310_BORDEROS_TESTE').split(',')]
    .map((s) => soDig(s).padStart(6, '0')).filter((s) => s !== '000000'));
}
const ehBorderoTeste = (b) => borderosTeste().has(soDig(b).padStart(6, '0'));

const chaveDe = (t) => [t.prefixo, t.numero, t.parcela, t.cliente_cod, t.cliente_loja].map(trim).join('|');
const tituloDe = (t) => [t.prefixo, t.numero, t.parcela].map(trim).filter(Boolean).join('/');

/**
 * Decide o que a confirmacao de um borderô 310 faria. Puro (sem banco).
 *
 * titulos: SE1 do borderô [{prefixo, numero, parcela, tipo, cliente_cod, cliente_loja,
 *          numbco, portador, agencia, conta, bordero, valor, saldo, status, vencimento}]
 * emLotes: { 'pre|num|par|cli|loja': [{ id_lote, banco_cod, status_banco }] }
 *
 * Um titulo fica de fora quando:
 *   TITULO_BAIXADO       ja nao esta aberto (status != 'A' ou saldo zero)
 *   SEM_NOSSO_NUMERO     E1_NUMBCO nao tem os 11 digitos do 310
 *   CONTA_DIVERGENTE     ag/conta do titulo nao e' a cadastrada (o DV seria chute)
 *   EM_LOTE_OUTRO_BANCO  ainda REGISTRADO num lote de outro banco: os dois
 *                        boletos seriam disparaveis. Sincronizar aquele lote
 *                        (vira TRANSFERIDO) e confirmar de novo.
 * Ja num lote 310 -> ja_confirmados (idempotente).
 */
function planejarConfirmacao({ bordero, titulos, emLotes }) {
  const c = config();
  const out = { bordero: soDig(bordero).padStart(6, '0'), bordero_teste: ehBorderoTeste(bordero),
    a_confirmar: [], ja_confirmados: [], ignorados: [] };
  if (out.bordero_teste) {
    out.ignorados = (titulos || []).map((t) => ({ titulo: tituloDe(t), motivo: 'BORDERO_TESTE' }));
    return out;
  }
  for (const t of titulos || []) {
    const titulo = tituloDe(t);
    const lotes = (emLotes || {})[chaveDe(t)] || [];
    if (lotes.some((l) => trim(l.banco_cod) === BANCO)) {
      out.ja_confirmados.push({ titulo, lotes: lotes.filter((l) => trim(l.banco_cod) === BANCO).map((l) => l.id_lote) });
      continue;
    }
    if (trim(t.status) !== 'A' || !(Number(t.saldo) > 0)) { out.ignorados.push({ titulo, motivo: 'TITULO_BAIXADO' }); continue; }
    if (!/^\d{11}$/.test(trim(t.numbco))) { out.ignorados.push({ titulo, motivo: 'SEM_NOSSO_NUMERO', nosso_numero: trim(t.numbco) }); continue; }
    if (semZeros(t.agencia) !== semZeros(c.agencia) || semZeros(t.conta) !== semZeros(c.conta)) {
      out.ignorados.push({ titulo, motivo: 'CONTA_DIVERGENTE', agencia: trim(t.agencia), conta: trim(t.conta) });
      continue;
    }
    const ativo = lotes.find((l) => trim(l.status_banco) === 'REGISTRADO');
    if (ativo) { out.ignorados.push({ titulo, motivo: 'EM_LOTE_OUTRO_BANCO', lote: ativo.id_lote, banco: trim(ativo.banco_cod) }); continue; }
    out.a_confirmar.push(t);
  }
  return out;
}

module.exports = { BANCO, config, ehVortx, coordenadas, dadosBoleto, borderosTeste, ehBorderoTeste, planejarConfirmacao, chaveDe, tituloDe };
