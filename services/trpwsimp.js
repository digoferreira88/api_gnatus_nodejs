// Cliente do TRPWSIMP — Template TOTVS de Importacao de Dados (MIT072).
//
// Endpoints expostos pelo Protheus:
//   POST /TRPWSIMP — importa dados em massa (47+ IDs disponiveis)
//   GET  /TRPWSIMP — consulta as regras pre-cadastradas no ERP
//
// Autenticacao: BASIC AUTH (user/senha Protheus em base64). NAO persistimos
// as credenciais — operador informa a cada execucao.
//
// URL base: configurada em PROTHEUS_TRPWSIMP_URL no .env (default = mesmo
// host do AprovaCompras na porta padrao do REST do Protheus).

const axios = require('axios');

const BASE_URL = process.env.PROTHEUS_TRPWSIMP_URL
  || process.env.PROTHEUS_REST_URL
  || 'http://protheus.gnatus.com.br:8091';

// Catalogo dos IDs disponiveis (extraido do MIT072). Lista completa pra o
// frontend popular o dropdown sem precisar consultar o Protheus.
const MODELOS = [
  { id: 1,  nome: 'Bancos (MATA070)' },
  { id: 2,  nome: 'Clientes (MATA030)' },
  { id: 3,  nome: 'Condição Pagamento (MATA360)' },
  { id: 4,  nome: 'Títulos a Receber (FINA040)' },
  { id: 5,  nome: 'Títulos a Receber - Baixas (FINA070)' },
  { id: 6,  nome: 'Títulos a Pagar (FINA050)' },
  { id: 7,  nome: 'Fornecedores (MATA020)' },
  { id: 8,  nome: 'Natureza (FINA010)' },
  { id: 9,  nome: 'Produtos (MATA010)' },
  { id: 10, nome: 'Saldo Inicial - Lote/SubLote/Endereço (MATA220)' },
  { id: 11, nome: 'TES (MATA080)' },
  { id: 12, nome: 'Tipo Movimentação Estoque (MATA230)' },
  { id: 13, nome: 'Transportadora (MATA050)' },
  { id: 14, nome: 'Vendedor (MATA040)' },
  { id: 15, nome: 'Produto x Fornecedor (MATA061)' },
  { id: 16, nome: 'Grupo Produto (MATA035)' },
  { id: 17, nome: 'Títulos a Pagar - Baixas (FINA080)' },
  { id: 18, nome: 'Movimentos Internos (MATA241)' },
  { id: 19, nome: 'Recursos do Projeto (PMSA203)' },
  { id: 20, nome: 'Estrutura de Produto (MATA200)' },
  { id: 21, nome: 'Medição/Encerramento Contrato (CNTA121)' },
  { id: 22, nome: 'Venda Assistida (LOJA701)' },
  { id: 23, nome: 'Ativos Imobilizados (ATFA010)' },
  { id: 24, nome: 'Pedidos Venda (MATA410)' },
  { id: 25, nome: 'Contratos Parceria (FATA400)' },
  { id: 26, nome: 'Pedidos Compra (MATA120)' },
  { id: 27, nome: 'Inventário (MATA270)' },
  { id: 28, nome: 'Indicadores (MATA019)' },
  { id: 29, nome: 'Pré-nota (MATA140)' },
  { id: 30, nome: 'Desmontagem (MATA242)' },
  { id: 31, nome: 'Ordem Produção e Empenho (MATA650)' },
  { id: 32, nome: 'Apontamento de Perda (MATA685)' },
  { id: 33, nome: 'Pedidos Venda - Liberação (MATA440)' },
  { id: 34, nome: 'Pedidos Venda - Liberação Estoque Auto (MATA455)' },
  { id: 35, nome: 'Montagem Carga (OMSA200)' },
  { id: 36, nome: 'Livros Fiscais - NF Saída (MATA920)' },
  { id: 37, nome: 'Funcionários (GPEA010)' },
  { id: 38, nome: 'Dependentes (GPEA020)' },
  { id: 39, nome: 'Lançamentos Acumulados (GPEA120)' },
  { id: 40, nome: 'Lançamentos Contábeis (CTBA102)' },
  { id: 41, nome: 'Complemento Produtos (MATA180)' },
  { id: 42, nome: 'Metas Venda (FATA050)' },
  { id: 43, nome: 'Previsão Vendas (MATA700)' },
  { id: 44, nome: 'Veículos (OMSA060)' },
  { id: 45, nome: 'Motoristas (OMSA040)' },
  { id: 46, nome: 'Movimentos Bancário (FINA100)' },
  { id: 47, nome: 'Documento Entrada (MATA103)' },
  { id: 99, nome: 'Genérico (via RecLock — sem ExecAuto)' }
];

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// GET /TRPWSIMP — consulta regras de um modelo
async function consultarRegras({ user, pass, empresa, filial, id, tabela = '' }) {
  const url = BASE_URL.replace(/\/$/, '') + '/rest/TRPWSIMP';
  const { data } = await axios.get(url, {
    headers: { Authorization: basicAuth(user, pass), 'Content-Type': 'application/json' },
    data: { EMPRESA: empresa, FILIAL: filial, ID: Number(id), TABELA: tabela },
    timeout: 60000,
    transformRequest: [(d) => JSON.stringify(d)]   // axios GET nao manda body por padrao
  });
  return data;
}

// POST /TRPWSIMP — importa em massa
async function importar({ user, pass, empresa, filial, id, tabela = '', titCampos, nomCampos, dados }) {
  const url = BASE_URL.replace(/\/$/, '') + '/rest/TRPWSIMP';
  const body = {
    EMPRESA: empresa,
    FILIAL: filial,
    ID: Number(id),
    TABELA: tabela,
    TITCAMPOS: titCampos,
    NOMCAMPOS: nomCampos,
    DADOS: dados
  };
  const { data, status } = await axios.post(url, body, {
    headers: { Authorization: basicAuth(user, pass), 'Content-Type': 'application/json' },
    timeout: 600000,
    validateStatus: () => true   // aceita 4xx pra retornar o body de erro detalhado
  });
  return { http: status, body: data };
}

module.exports = { consultarRegras, importar, MODELOS, BASE_URL };
