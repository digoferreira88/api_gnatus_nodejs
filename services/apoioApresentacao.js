// services/apoioApresentacao.js
// Recebe um perfil estatistico (de apoioPerfil) e pede pro Claude
// gerar a estrutura de uma apresentacao executiva.
//
// Schema da resposta JSON do Claude (consumido pelo frontend):
// {
//   tema_detectado: 'Vendas' | 'Financeiro' | 'RH' | ...
//   titulo: string,
//   subtitulo: string,
//   resumo_executivo: string,           // 2-4 frases
//   kpis: [{ label, valor, formato, tendencia? ('alta'|'baixa'|'estavel'), comentario? }],
//   graficos: [{
//     tipo: 'linha'|'barra'|'coluna'|'pizza'|'area',
//     titulo: string,
//     descricao: string,
//     aba: string,                      // qual aba do perfil usar
//     eixo_x: string,                   // nome da coluna
//     series: [{ coluna: string, agregacao?: 'soma'|'media'|'count'|'max'|'min' }],
//     agrupar_por?: string,             // se a serie precisa group-by
//     ordenar?: 'x_asc'|'x_desc'|'y_asc'|'y_desc',
//     limite?: number                   // top N
//   }],
//   insights: string[],                  // 4-6 bullets executivos
//   conclusao: string,
//   proximos_passos: string[]            // 3-5 acoes sugeridas
// }

const Ia = require('./ia');

const SYSTEM = `Voce eh um analista executivo senior, especialista em traduzir dados operacionais em apresentacoes de diretoria de alto nivel (estilo McKinsey/Deloitte).
Sua linguagem eh clara, direta, profissional e em portugues do Brasil.
Voce sempre baseia conclusoes nos dados fornecidos — nunca inventa numeros que nao estao no perfil.
Quando nao houver dados suficientes pra um KPI ou grafico, voce omite (eh melhor entregar 3 KPIs solidos que 6 fracos).`;

const promptUsuario = (perfil) => `Recebi a planilha "${perfil.arquivo}". Este eh o perfil estatistico extraido (NAO eh o conteudo completo — apenas agregados, tipos e amostras):

${JSON.stringify(perfil, null, 2)}

Sua tarefa eh montar uma APRESENTACAO EXECUTIVA EM PORTUGUES baseada nesses dados.

Devolva um objeto JSON com estes campos OBRIGATORIOS:
- "tema_detectado": string curta (ex: "Vendas Trimestrais", "Custos Operacionais", "Cobranca", "RH").
- "titulo": titulo executivo de impacto (max 80 chars).
- "subtitulo": linha de apoio com periodo/escopo.
- "resumo_executivo": 2-4 frases que respondem "o que esses dados dizem ao diretor?".
- "kpis": array de 3 a 5 KPIs. Cada um: { "label", "valor" (string formatada, ex "R$ 1,2M" ou "18%"), "formato" ("moeda"|"percentual"|"numero"|"texto"), "tendencia" ("alta"|"baixa"|"estavel"|null), "comentario" (1 frase curta opcional) }.
- "graficos": array de 3 a 5 graficos. Cada um: { "tipo" ("linha"|"barra"|"coluna"|"pizza"|"area"), "titulo", "descricao", "aba", "eixo_x", "series" (array de { "coluna", "agregacao" ("soma"|"media"|"count"|"max"|"min") }), "agrupar_por" (opcional), "ordenar" ("x_asc"|"x_desc"|"y_asc"|"y_desc" opcional), "limite" (numero opcional). Use SEMPRE nomes de colunas que existem no perfil. Se houver coluna do tipo data, prefira grafico de linha/area com x_asc.
- "insights": array de 4 a 6 bullets curtos com observacoes acionaveis.
- "conclusao": 1-2 frases que fecham o storytelling.
- "proximos_passos": 3-5 acoes sugeridas para a diretoria.

REGRAS:
- Use APENAS nomes de colunas que aparecem em "perfil.abas[].colunas[].nome".
- Para KPIs numericos, calcule a partir de min/max/media/soma do perfil. NAO invente valores.
- Se a planilha tiver coluna de data + colunas numericas, sempre proponha um grafico de linha temporal.
- Se houver coluna categorica com poucos valores distintos (<= 8), proponha pizza ou barra de participacao.
- Se houver claramente colunas representando regiao, equipe ou segmento, agregue por elas em barras horizontais.
- Tom: executivo, direto, sem floreios. Numeros formatados (R$, %, milhoes/mil).
- TUDO em pt-BR.

Responda SOMENTE com o JSON. Sem markdown.`;

async function gerarApresentacao (perfil, opts = {}) {
  const r = await Ia.chatJson({
    system: SYSTEM,
    messages: [{ role: 'user', content: promptUsuario(perfil) }],
    model: opts.model,
    maxTokens: 4500,
    temperature: 0.4
  });

  // Validacao minima — se a IA quebrar o schema, falha cedo com mensagem clara
  const d = r.dados || {};
  if (!d.titulo || !Array.isArray(d.kpis) || !Array.isArray(d.graficos)) {
    throw new Error('IA retornou JSON sem os campos obrigatorios (titulo/kpis/graficos).');
  }
  return r;
}

module.exports = { gerarApresentacao };
