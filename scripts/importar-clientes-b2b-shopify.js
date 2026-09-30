// scripts/importar-clientes-b2b-shopify.js
//
// Leva os clientes B2B do PORTAL ANTIGO para a loja Shopify, já vinculados ao
// Protheus. Roda sob demanda (não é serviço); nasce em modo seco.
//
// POR QUE ISSO IMPORTA MAIS DO QUE PARECE
// O pedido do Shopify só vira pedido no ERP se der para achar o cliente. Hoje nada
// liga a empresa da loja ao cadastro do Protheus: o `Company.externalId` está nulo
// em quase todos os cadastros B2B existentes, e dos 12 medidos em 29/09 NENHUM
// casou com a SA1. Importando daqui, cada empresa nasce com:
//     Company.externalId                  = erp_cliente (A1_COD)   <- o vínculo
//     CompanyLocation.taxRegistrationId   = CNPJ                    <- a rede de segurança
// Assim a falha de cadastro acontece AQUI, com um humano olhando, e não no checkout
// do cliente depois de ele já ter pagado.
//
// FONTE: `config/web/config.db` do portal antigo — SQLite, tabela `users`, com
// `cpfcnpj`, `erp_cliente` e `erp_vendedor`. Em 29/09: 433 usuários, 235 com código
// ERP. Amostra de 25 conferida contra a SA1: 25/25 bateram.
//
// USO (a partir de api_ecopower_nodejs/):
//   node --experimental-sqlite scripts/importar-clientes-b2b-shopify.js \
//        --db "<caminho>/config.db" [--limite N] [--cnpj 03564661000138] [--gravar]
//
// Sem `--gravar` NADA é criado na loja: apenas mostra o que faria.
// Exige o escopo `write_customers` (ou `write_companies`) no app da loja.

require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const Api = require('../services/shopifyApi');
const Protheus = require('../services/protheus');
const Staging = require('../services/protheusPedidoStaging');

const arg = (nome, padrao = null) => {
  const i = process.argv.indexOf('--' + nome);
  return i > -1 ? (process.argv[i + 1] || true) : padrao;
};
const GRAVAR = process.argv.includes('--gravar');
const LIMITE = parseInt(arg('limite', '1'), 10) || 1;
const CNPJ_ALVO = String(arg('cnpj', '') || '').replace(/\D/g, '');
const DB = arg('db');

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');

const M_CRIAR = `
  mutation($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company {
        id name externalId
        locations(first: 1) { nodes { id name taxRegistrationId } }
        contacts(first: 1) { nodes { customer { id email } } }
      }
      userErrors { field message }
    }
  }`;

// Já existe na loja? Procura pelo externalId (o código do ERP) — é a chave do vínculo.
async function jaExiste(erpCliente) {
  const d = await Api.gql(
    `query($q: String!) { companies(first: 5, query: $q) { nodes { id name externalId } } }`,
    { q: `external_id:${erpCliente}` });
  return (d?.companies?.nodes || []).find((c) => trim(c.externalId) === trim(erpCliente)) || null;
}

async function main() {
  if (!DB) throw new Error('faltou --db com o caminho do config.db do portal antigo');
  if (!Api.configurado()) throw new Error('Shopify não configurado no .env');

  console.log(GRAVAR ? '### MODO GRAVAÇÃO — vai criar empresa na loja ###'
                     : '### modo seco — nada será criado (use --gravar para valer) ###');

  const db = new DatabaseSync(DB, { readOnly: true });
  let sql = `SELECT id, name, email, cpfcnpj, erp_cliente, erp_vendedor
               FROM users
              WHERE TRIM(COALESCE(erp_cliente,'')) <> ''
                AND TRIM(COALESCE(cpfcnpj,'')) <> ''
                AND active = 1`;
  if (CNPJ_ALVO) sql += ` AND REPLACE(REPLACE(REPLACE(cpfcnpj,'.',''),'/',''),'-','') = '${CNPJ_ALVO}'`;
  sql += ` ORDER BY lastaccess DESC`;
  const users = db.prepare(sql).all();
  console.log(`${users.length} candidato(s) no portal\n`);

  const resumo = { conferidos: 0, criados: 0, jaExistiam: 0, recusados: 0 };

  for (const u of users) {
    if (resumo.criados + resumo.jaExistiam + resumo.recusados >= LIMITE) break;
    resumo.conferidos++;

    const doc = soDig(u.cpfcnpj);
    const erp = trim(u.erp_cliente);
    const nome = trim(u.name);
    const rotulo = `${nome.slice(0, 32).padEnd(32)} erp=${erp}`;

    // 1) documento precisa ser válido — documento zerado casa com cliente real na SA1
    if (!Staging.digitosValidos(doc)) {
      console.log(`  ✗ ${rotulo} documento "${u.cpfcnpj}" inválido`);
      resumo.recusados++; continue;
    }

    // 2) o cliente precisa existir na SA1 E o código precisa bater com o do portal
    const sa1 = await Staging.resolverCliente(Protheus, doc);
    if (!sa1.achou) { console.log(`  ✗ ${rotulo} CNPJ ${doc} não está na SA1`); resumo.recusados++; continue; }
    if (sa1.codigo !== erp) {
      console.log(`  ✗ ${rotulo} divergência: portal diz ${erp}, SA1 diz ${sa1.codigo}`);
      resumo.recusados++; continue;
    }
    if (sa1.bloqueado) { console.log(`  ✗ ${rotulo} cliente BLOQUEADO no Protheus`); resumo.recusados++; continue; }

    // 3) idempotência: não recriar quem já foi importado
    const existente = await jaExiste(erp);
    if (existente) {
      console.log(`  = ${rotulo} já existe na loja (${existente.name})`);
      resumo.jaExistiam++; continue;
    }

    const input = {
      company: { name: sa1.nome || nome, externalId: erp },
      companyLocation: { name: sa1.nome || nome, taxRegistrationId: doc },
      ...(trim(u.email) ? { companyContact: { email: trim(u.email) } } : {})
    };

    if (!GRAVAR) {
      console.log(`  → ${rotulo} criaria: ${JSON.stringify(input)}`);
      resumo.criados++; continue;
    }

    try {
      const d = await Api.gql(M_CRIAR, { input });
      Api.checarUserErrors(d?.companyCreate, `criar ${erp}`);
      const c = d.companyCreate.company;
      console.log(`  ✓ ${rotulo} criada: ${c.id} externalId=${c.externalId} CNPJ=${c.locations?.nodes?.[0]?.taxRegistrationId}`);
      resumo.criados++;
    } catch (e) {
      console.log(`  ✗ ${rotulo} ${e.message.slice(0, 160)}`);
      resumo.recusados++;
    }
  }

  console.log('\nresumo:', JSON.stringify(resumo));
  if (!GRAVAR) console.log('(modo seco — nada foi criado)');
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
